<#
.SYNOPSIS
Audits Conjur variable values for values that appear to be secret paths/references instead of actual secret material.

.DESCRIPTION
This is an operator-only, read-only audit tool for the reviewed Conjur CLI 9.x integration.
It enumerates every visible variable, retrieves each value one at a time, classifies the value
in process memory, and emits only redacted findings. Secret values are never intentionally
printed, logged, or written to the report.

The script does not mutate Conjur. It invokes only:
  conjur --version
  conjur whoami --output json
  conjur list --kind variable --limit=-1 --output json
  conjur variable get --id <variable> --output json

Exit codes:
  0 = audit completed, no suspicious values
  2 = audit completed, suspicious values found
  3 = audit completed with one or more retrieval/parse failures
  1 = setup/listing/fatal failure
#>

[CmdletBinding()]
param(
    [string]$ConjurPath = 'conjur',
    [string]$OutputPath,
    [switch]$Force,
    [ValidatePattern('^[1-9][0-9]*(ms|s|m)$')]
    [string]$HttpTimeout = '30s',
    [ValidateRange(5, 3600)]
    [int]$ProcessTimeoutSeconds = 120,
    [ValidateRange(1, 1000000)]
    [int]$MaxVariables = 50000,
    [ValidateSet('High', 'Medium')]
    [string]$MinimumConfidence = 'Medium',
    [switch]$AllowUnsupportedVersion,
    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-OrdinalStringSet {
    return [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
}

function ConvertTo-WindowsCommandLineArgument {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Value
    )

    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }

    $builder = [System.Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $backslashCount = 0

    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashCount++
            continue
        }

        if ($character -eq '"') {
            if ($backslashCount -gt 0) {
                [void]$builder.Append(('\' * ($backslashCount * 2)))
            }
            [void]$builder.Append('\')
            [void]$builder.Append('"')
            $backslashCount = 0
            continue
        }

        if ($backslashCount -gt 0) {
            [void]$builder.Append(('\' * $backslashCount))
            $backslashCount = 0
        }
        [void]$builder.Append($character)
    }

    if ($backslashCount -gt 0) {
        [void]$builder.Append(('\' * ($backslashCount * 2)))
    }

    [void]$builder.Append('"')
    return $builder.ToString()
}

function Resolve-ConjurExecutable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if ([System.IO.Path]::IsPathRooted($Path)) {
        $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
        $item = Get-Item -LiteralPath $resolved.Path -ErrorAction Stop
        if ($item.PSIsContainer) {
            throw "ConjurPath must reference an executable file."
        }
        return $item.FullName
    }

    $command = Get-Command -Name $Path -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if ($null -eq $command -or [string]::IsNullOrWhiteSpace($command.Source)) {
        throw "Conjur executable could not be resolved."
    }
    return $command.Source
}

function Invoke-ConjurProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Executable,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [int]$TimeoutSeconds
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    if ($startInfo.PSObject.Properties.Name -contains 'ArgumentList') {
        foreach ($argument in $Arguments) {
            [void]$startInfo.ArgumentList.Add($argument)
        }
    }
    else {
        $quotedArguments = foreach ($argument in $Arguments) {
            ConvertTo-WindowsCommandLineArgument -Value $argument
        }
        $startInfo.Arguments = ($quotedArguments -join ' ')
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo

    try {
        if (-not $process.Start()) {
            throw "Failed to start the Conjur CLI."
        }

        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()

        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try {
                $process.Kill()
            }
            catch {
            }
            throw "Conjur command exceeded the process timeout."
        }

        $process.WaitForExit()

        return [pscustomobject][ordered]@{
            ExitCode = $process.ExitCode
            Stdout   = $stdoutTask.Result
            Stderr   = $stderrTask.Result
        }
    }
    finally {
        $process.Dispose()
    }
}

function ConvertFrom-ConjurJson {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Json,
        [Parameter(Mandatory = $true)]
        [string]$Context
    )

    if ([string]::IsNullOrWhiteSpace($Json)) {
        throw "$Context returned empty JSON output."
    }

    try {
        return $Json | ConvertFrom-Json
    }
    catch {
        throw "$Context returned output that was not valid JSON."
    }
}

function ConvertFrom-ResourceIdToVariableId {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ResourceId
    )

    $marker = ':variable:'
    $index = $ResourceId.IndexOf($marker, [System.StringComparison]::Ordinal)
    if ($index -lt 0) {
        return $ResourceId
    }

    $variableId = $ResourceId.Substring($index + $marker.Length)
    if ([string]::IsNullOrWhiteSpace($variableId)) {
        throw "Conjur returned an empty variable identifier."
    }
    return $variableId
}

function Normalize-ReferenceShape {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $normalized = $Value.Trim().Replace('\', '/').Replace('.', '/')
    while ($normalized.Contains('//')) {
        $normalized = $normalized.Replace('//', '/')
    }
    return $normalized.Trim('/')
}

function Test-SecretValueShape {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Value,
        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.HashSet[string]]$KnownReferences,
        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.HashSet[string]]$KnownNormalizedReferences
    )

    $candidate = $Value.Trim()
    if ([string]::IsNullOrEmpty($candidate) -or $candidate.Length -gt 2048) {
        return $null
    }

    if ($KnownReferences.Contains($candidate)) {
        return [pscustomobject][ordered]@{
            Confidence = 'High'
            Reason     = 'exact_known_variable_reference'
        }
    }

    $normalizedCandidate = Normalize-ReferenceShape -Value $candidate
    if (
        ($candidate.Contains('/') -or $candidate.Contains('\') -or $candidate.Contains('.')) -and
        -not [string]::IsNullOrEmpty($normalizedCandidate) -and
        $KnownNormalizedReferences.Contains($normalizedCandidate)
    ) {
        return [pscustomobject][ordered]@{
            Confidence = 'High'
            Reason     = 'normalized_known_variable_reference'
        }
    }

    if ($candidate -match '^(conjur|cyberark|idira)://[A-Za-z0-9_.@:/\\-]+$') {
        return [pscustomobject][ordered]@{
            Confidence = 'High'
            Reason     = 'secret_reference_uri'
        }
    }

    if (
        $candidate -match '\s' -or
        $candidate.StartsWith('{') -or
        $candidate.StartsWith('[') -or
        $candidate.StartsWith('-----BEGIN') -or
        $candidate -match '^[A-Za-z][A-Za-z0-9+.-]*://' -or
        $candidate.Contains('=')
    ) {
        return $null
    }

    # Common legitimate scalar formats can look superficially path-like. Exclude
    # them before applying medium-confidence heuristics.
    if (
        $candidate -match '^\d{1,3}(?:\.\d{1,3}){3}
    if ($candidate -match $pathPattern) {
        if ($candidate -match ('(?:^|[\\/])' + $secretFieldSuffix + '
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'path_with_secret_field_suffix'
            }
        }

        $separatorCount = ([System.Text.RegularExpressions.Regex]::Matches($candidate, '[./\\]')).Count
        if ($separatorCount -ge 3) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'hierarchical_reference_shape'
            }
        }
    }

    return $null
}

function Test-MeetsMinimumConfidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Confidence,
        [Parameter(Mandatory = $true)]
        [string]$Minimum
    )

    if ($Minimum -eq 'High') {
        return $Confidence -eq 'High'
    }
    return $Confidence -eq 'High' -or $Confidence -eq 'Medium'
}

function Invoke-ClassifierSelfTest {
    $references = New-OrdinalStringSet
    $normalizedReferences = New-OrdinalStringSet

    foreach ($reference in @(
        'prod/service/password',
        'RH/value/value/value/password',
        'acme:variable:prod/service/token'
    )) {
        [void]$references.Add($reference)
        [void]$normalizedReferences.Add((Normalize-ReferenceShape -Value $reference))
    }

    $cases = @(
        [pscustomobject]@{ Name = 'exact known path'; Value = 'prod/service/password'; Confidence = 'High'; Reason = 'exact_known_variable_reference' },
        [pscustomobject]@{ Name = 'normalized dot path'; Value = 'RH.value.value.value/password'; Confidence = 'High'; Reason = 'normalized_known_variable_reference' },
        [pscustomobject]@{ Name = 'reference URI'; Value = 'conjur://prod/service/password'; Confidence = 'High'; Reason = 'secret_reference_uri' },
        [pscustomobject]@{ Name = 'dot slash notation shape'; Value = 'other.team.database/password'; Confidence = 'Medium'; Reason = 'dot_notation_reference_shape' },
        [pscustomobject]@{ Name = 'dot credential suffix'; Value = 'other.team.database.password'; Confidence = 'Medium'; Reason = 'dot_notation_reference_shape' },
        [pscustomobject]@{ Name = 'credential suffix'; Value = 'other/service/password'; Confidence = 'Medium'; Reason = 'path_with_secret_field_suffix' },
        [pscustomobject]@{ Name = 'hierarchical path'; Value = 'other/service/env/region/value'; Confidence = 'Medium'; Reason = 'hierarchical_reference_shape' },
        [pscustomobject]@{ Name = 'ordinary password'; Value = 'correct-horse-battery-staple'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'URL'; Value = 'https://example.com/a/b/c'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'JSON'; Value = '{"password":"not-a-reference"}'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'connection string'; Value = 'Server=db;Password=example'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'semantic version'; Value = '1.2.3'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'IPv4 address'; Value = '10.20.30.40'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'hostname'; Value = 'db.prod.example.com'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'JWT shape'; Value = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'; Confidence = $null; Reason = $null }
    )

    foreach ($case in $cases) {
        $actual = Test-SecretValueShape -Value $case.Value -KnownReferences $references -KnownNormalizedReferences $normalizedReferences

        if ($null -eq $case.Confidence) {
            if ($null -ne $actual) {
                throw "Self-test '$($case.Name)' unexpectedly classified as $($actual.Confidence)/$($actual.Reason)."
            }
            continue
        }

        if ($null -eq $actual) {
            throw "Self-test '$($case.Name)' unexpectedly produced no finding."
        }
        if ($actual.Confidence -ne $case.Confidence -or $actual.Reason -ne $case.Reason) {
            throw "Self-test '$($case.Name)' returned $($actual.Confidence)/$($actual.Reason), expected $($case.Confidence)/$($case.Reason)."
        }
    }

    Write-Host "Self-test passed: $($cases.Count) classifier cases."
}

if ($SelfTest) {
    Invoke-ClassifierSelfTest
    exit 0
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or later is required."
    }

    $resolvedConjur = Resolve-ConjurExecutable -Path $ConjurPath

    $versionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--version') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($versionResult.ExitCode -ne 0) {
        throw "Unable to read the Conjur CLI version."
    }

    $versionMatch = [System.Text.RegularExpressions.Regex]::Match($versionResult.Stdout, '(?<![0-9])([0-9]+)\.([0-9]+)\.([0-9]+)')
    if (-not $versionMatch.Success) {
        throw "Unable to parse the Conjur CLI version."
    }

    $majorVersion = [int]$versionMatch.Groups[1].Value
    if ($majorVersion -ne 9 -and -not $AllowUnsupportedVersion) {
        throw "This audit is qualified for Conjur CLI 9.x. Re-run with -AllowUnsupportedVersion only after reviewing CLI output compatibility."
    }

    $sessionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'whoami', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($sessionResult.ExitCode -ne 0) {
        throw "Conjur session verification failed. Authenticate with the approved vendor flow before auditing."
    }
    $null = ConvertFrom-ConjurJson -Json $sessionResult.Stdout -Context 'conjur whoami'

    $listResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'list', '--kind', 'variable', '--limit=-1', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($listResult.ExitCode -ne 0) {
        throw "Conjur variable enumeration failed."
    }

    $listed = ConvertFrom-ConjurJson -Json $listResult.Stdout -Context 'conjur list'
    if ($null -eq $listed) {
        $resources = @()
    }
    else {
        $resources = @($listed)
    }

    $records = New-Object 'System.Collections.Generic.List[object]'
    $resourceIds = New-OrdinalStringSet
    $knownReferences = New-OrdinalStringSet
    $knownNormalizedReferences = New-OrdinalStringSet

    foreach ($resource in $resources) {
        if ($null -eq $resource) {
            throw "Conjur list returned a null variable entry; refusing a partial audit."
        }

        $idProperty = $resource.PSObject.Properties['id']
        if ($null -eq $idProperty -or [string]::IsNullOrWhiteSpace([string]$idProperty.Value)) {
            throw "Conjur list returned a variable entry without an id; refusing a partial audit."
        }

        $resourceId = [string]$idProperty.Value
        if (-not $resourceIds.Add($resourceId)) {
            continue
        }

        $variableId = ConvertFrom-ResourceIdToVariableId -ResourceId $resourceId
        [void]$knownReferences.Add($resourceId)
        [void]$knownReferences.Add($variableId)
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $resourceId))
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $variableId))

        $records.Add([pscustomobject][ordered]@{
            ResourceId = $resourceId
            VariableId = $variableId
        })
    }

    $orderedRecords = @($records | Sort-Object -Property VariableId, ResourceId)
    if ($orderedRecords.Count -gt $MaxVariables) {
        throw "Conjur returned $($orderedRecords.Count) visible variables, exceeding MaxVariables=$MaxVariables. Increase -MaxVariables deliberately to audit the full set."
    }

    $findings = New-Object 'System.Collections.Generic.List[object]'
    $failures = New-Object 'System.Collections.Generic.List[object]'
    $inspected = 0

    for ($index = 0; $index -lt $orderedRecords.Count; $index++) {
        $record = $orderedRecords[$index]
        $position = $index + 1
        $percent = 100
        if ($orderedRecords.Count -gt 0) {
            $percent = [int](($position / [double]$orderedRecords.Count) * 100)
        }
        Write-Progress -Activity 'Auditing Conjur variable values' -Status "$position of $($orderedRecords.Count)" -PercentComplete $percent

        $getResult = $null
        $secretObject = $null
        $secretValue = $null

        try {
            $getResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'variable', 'get', '--id', $record.VariableId, '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
            if ($getResult.ExitCode -ne 0) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'retrieval_failed'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            try {
                $secretObject = ConvertFrom-ConjurJson -Json $getResult.Stdout -Context 'conjur variable get'
            }
            catch {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'invalid_secret_json'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $valueProperty = $secretObject.PSObject.Properties['value']
            if ($null -eq $valueProperty) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'missing_value_field'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $secretValue = [string]$valueProperty.Value
            $inspected++

            $classification = Test-SecretValueShape -Value $secretValue -KnownReferences $knownReferences -KnownNormalizedReferences $knownNormalizedReferences
            if ($null -ne $classification -and (Test-MeetsMinimumConfidence -Confidence $classification.Confidence -Minimum $MinimumConfidence)) {
                $findings.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    Confidence = $classification.Confidence
                    Reason     = $classification.Reason
                })
            }
        }
        finally {
            $secretValue = $null
            $secretObject = $null
            $getResult = $null
        }
    }

    Write-Progress -Activity 'Auditing Conjur variable values' -Completed

    $report = [pscustomobject][ordered]@{
        SchemaVersion     = 1
        GeneratedAtUtc    = [DateTime]::UtcNow.ToString('o')
        ConjurVersion     = $versionMatch.Value
        TotalVariables    = $orderedRecords.Count
        InspectedValues   = $inspected
        SuspiciousValues  = $findings.Count
        RetrievalFailures = $failures.Count
        MinimumConfidence = $MinimumConfidence
        MaxVariables      = $MaxVariables
        Findings          = @($findings)
        Failures          = @($failures)
    }

    Write-Host ""
    Write-Host "Conjur secret-value audit complete."
    Write-Host "Variables enumerated : $($report.TotalVariables)"
    Write-Host "Values inspected     : $($report.InspectedValues)"
    Write-Host "Suspicious values    : $($report.SuspiciousValues)"
    Write-Host "Retrieval failures   : $($report.RetrievalFailures)"
    Write-Host "Secret values were not printed or written to the report."

    if ($findings.Count -gt 0) {
        Write-Host ""
        Write-Host "Suspicious values (value omitted):"
        $findings |
            Sort-Object -Property Confidence, VariableId |
            Format-Table -Property VariableId, Confidence, Reason -AutoSize |
            Out-Host
    }

    if ($failures.Count -gt 0) {
        Write-Host ""
        Write-Host "Variables that could not be fully inspected:"
        $failures |
            Sort-Object -Property VariableId |
            Format-Table -Property VariableId, ErrorCode, ExitCode -AutoSize |
            Out-Host
    }

    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
        $parent = Split-Path -Parent $fullOutputPath
        if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw "OutputPath parent directory does not exist."
        }
        if ((Test-Path -LiteralPath $fullOutputPath) -and -not $Force) {
            throw "OutputPath already exists. Use -Force to replace the redacted report."
        }

        $json = $report | ConvertTo-Json -Depth 8
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        if ($Force) {
            [System.IO.File]::WriteAllText($fullOutputPath, $json, $utf8NoBom)
        }
        else {
            $bytes = $utf8NoBom.GetBytes($json)
            $stream = [System.IO.File]::Open(
                $fullOutputPath,
                [System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None
            )
            try {
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.Flush()
            }
            finally {
                $stream.Dispose()
            }
        }
        Write-Host "Redacted report      : $fullOutputPath"
    }

    if ($failures.Count -gt 0) {
        exit 3
    }
    if ($findings.Count -gt 0) {
        exit 2
    }
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
 -or
        $candidate -match '^v?\d+(?:\.\d+){2,}(?:[-+][A-Za-z0-9.-]+)?
    if ($candidate -match $pathPattern) {
        if ($candidate -match '(?:^|[\\/])(password|passwd|pwd|username|user|token|api[-_]?key|secret|client[-_]?secret|private[-_]?key|access[-_]?key|credential|credentials)$') {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'path_with_secret_field_suffix'
            }
        }

        $separatorCount = ([System.Text.RegularExpressions.Regex]::Matches($candidate, '[./\\]')).Count
        if ($separatorCount -ge 3) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'hierarchical_reference_shape'
            }
        }
    }

    return $null
}

function Test-MeetsMinimumConfidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Confidence,
        [Parameter(Mandatory = $true)]
        [string]$Minimum
    )

    if ($Minimum -eq 'High') {
        return $Confidence -eq 'High'
    }
    return $Confidence -eq 'High' -or $Confidence -eq 'Medium'
}

function Invoke-ClassifierSelfTest {
    $references = New-OrdinalStringSet
    $normalizedReferences = New-OrdinalStringSet

    foreach ($reference in @(
        'prod/service/password',
        'RH/value/value/value/password',
        'acme:variable:prod/service/token'
    )) {
        [void]$references.Add($reference)
        [void]$normalizedReferences.Add((Normalize-ReferenceShape -Value $reference))
    }

    $cases = @(
        [pscustomobject]@{ Name = 'exact known path'; Value = 'prod/service/password'; Confidence = 'High'; Reason = 'exact_known_variable_reference' },
        [pscustomobject]@{ Name = 'normalized dot path'; Value = 'RH.value.value.value/password'; Confidence = 'High'; Reason = 'normalized_known_variable_reference' },
        [pscustomobject]@{ Name = 'reference URI'; Value = 'conjur://prod/service/password'; Confidence = 'High'; Reason = 'secret_reference_uri' },
        [pscustomobject]@{ Name = 'dot notation shape'; Value = 'other.team.database/password'; Confidence = 'Medium'; Reason = 'dot_notation_reference_shape' },
        [pscustomobject]@{ Name = 'credential suffix'; Value = 'other/service/password'; Confidence = 'Medium'; Reason = 'path_with_secret_field_suffix' },
        [pscustomobject]@{ Name = 'hierarchical path'; Value = 'other/service/env/region/value'; Confidence = 'Medium'; Reason = 'hierarchical_reference_shape' },
        [pscustomobject]@{ Name = 'ordinary password'; Value = 'correct-horse-battery-staple'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'URL'; Value = 'https://example.com/a/b/c'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'JSON'; Value = '{"password":"not-a-reference"}'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'connection string'; Value = 'Server=db;Password=example'; Confidence = $null; Reason = $null }
    )

    foreach ($case in $cases) {
        $actual = Test-SecretValueShape -Value $case.Value -KnownReferences $references -KnownNormalizedReferences $normalizedReferences

        if ($null -eq $case.Confidence) {
            if ($null -ne $actual) {
                throw "Self-test '$($case.Name)' unexpectedly classified as $($actual.Confidence)/$($actual.Reason)."
            }
            continue
        }

        if ($null -eq $actual) {
            throw "Self-test '$($case.Name)' unexpectedly produced no finding."
        }
        if ($actual.Confidence -ne $case.Confidence -or $actual.Reason -ne $case.Reason) {
            throw "Self-test '$($case.Name)' returned $($actual.Confidence)/$($actual.Reason), expected $($case.Confidence)/$($case.Reason)."
        }
    }

    Write-Host "Self-test passed: $($cases.Count) classifier cases."
}

if ($SelfTest) {
    Invoke-ClassifierSelfTest
    exit 0
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or later is required."
    }

    $resolvedConjur = Resolve-ConjurExecutable -Path $ConjurPath

    $versionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--version') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($versionResult.ExitCode -ne 0) {
        throw "Unable to read the Conjur CLI version."
    }

    $versionMatch = [System.Text.RegularExpressions.Regex]::Match($versionResult.Stdout, '(?<![0-9])([0-9]+)\.([0-9]+)\.([0-9]+)')
    if (-not $versionMatch.Success) {
        throw "Unable to parse the Conjur CLI version."
    }

    $majorVersion = [int]$versionMatch.Groups[1].Value
    if ($majorVersion -ne 9 -and -not $AllowUnsupportedVersion) {
        throw "This audit is qualified for Conjur CLI 9.x. Re-run with -AllowUnsupportedVersion only after reviewing CLI output compatibility."
    }

    $sessionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'whoami', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($sessionResult.ExitCode -ne 0) {
        throw "Conjur session verification failed. Authenticate with the approved vendor flow before auditing."
    }
    $null = ConvertFrom-ConjurJson -Json $sessionResult.Stdout -Context 'conjur whoami'

    $listResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'list', '--kind', 'variable', '--limit=-1', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($listResult.ExitCode -ne 0) {
        throw "Conjur variable enumeration failed."
    }

    $listed = ConvertFrom-ConjurJson -Json $listResult.Stdout -Context 'conjur list'
    if ($null -eq $listed) {
        $resources = @()
    }
    else {
        $resources = @($listed)
    }

    $records = New-Object 'System.Collections.Generic.List[object]'
    $resourceIds = New-OrdinalStringSet
    $knownReferences = New-OrdinalStringSet
    $knownNormalizedReferences = New-OrdinalStringSet

    foreach ($resource in $resources) {
        if ($null -eq $resource) {
            throw "Conjur list returned a null variable entry; refusing a partial audit."
        }

        $idProperty = $resource.PSObject.Properties['id']
        if ($null -eq $idProperty -or [string]::IsNullOrWhiteSpace([string]$idProperty.Value)) {
            throw "Conjur list returned a variable entry without an id; refusing a partial audit."
        }

        $resourceId = [string]$idProperty.Value
        if (-not $resourceIds.Add($resourceId)) {
            continue
        }

        $variableId = ConvertFrom-ResourceIdToVariableId -ResourceId $resourceId
        [void]$knownReferences.Add($resourceId)
        [void]$knownReferences.Add($variableId)
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $resourceId))
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $variableId))

        $records.Add([pscustomobject][ordered]@{
            ResourceId = $resourceId
            VariableId = $variableId
        })
    }

    $orderedRecords = @($records | Sort-Object -Property VariableId, ResourceId)
    $findings = New-Object 'System.Collections.Generic.List[object]'
    $failures = New-Object 'System.Collections.Generic.List[object]'
    $inspected = 0

    for ($index = 0; $index -lt $orderedRecords.Count; $index++) {
        $record = $orderedRecords[$index]
        $position = $index + 1
        $percent = 100
        if ($orderedRecords.Count -gt 0) {
            $percent = [int](($position / [double]$orderedRecords.Count) * 100)
        }
        Write-Progress -Activity 'Auditing Conjur variable values' -Status "$position of $($orderedRecords.Count)" -PercentComplete $percent

        $getResult = $null
        $secretObject = $null
        $secretValue = $null

        try {
            $getResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'variable', 'get', '--id', $record.VariableId, '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
            if ($getResult.ExitCode -ne 0) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'retrieval_failed'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            try {
                $secretObject = ConvertFrom-ConjurJson -Json $getResult.Stdout -Context 'conjur variable get'
            }
            catch {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'invalid_secret_json'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $valueProperty = $secretObject.PSObject.Properties['value']
            if ($null -eq $valueProperty) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'missing_value_field'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $secretValue = [string]$valueProperty.Value
            $inspected++

            $classification = Test-SecretValueShape -Value $secretValue -KnownReferences $knownReferences -KnownNormalizedReferences $knownNormalizedReferences
            if ($null -ne $classification -and (Test-MeetsMinimumConfidence -Confidence $classification.Confidence -Minimum $MinimumConfidence)) {
                $findings.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    Confidence = $classification.Confidence
                    Reason     = $classification.Reason
                })
            }
        }
        finally {
            $secretValue = $null
            $secretObject = $null
            $getResult = $null
        }
    }

    Write-Progress -Activity 'Auditing Conjur variable values' -Completed

    $report = [pscustomobject][ordered]@{
        SchemaVersion     = 1
        GeneratedAtUtc    = [DateTime]::UtcNow.ToString('o')
        ConjurVersion     = $versionMatch.Value
        TotalVariables    = $orderedRecords.Count
        InspectedValues   = $inspected
        SuspiciousValues  = $findings.Count
        RetrievalFailures = $failures.Count
        MinimumConfidence = $MinimumConfidence
        Findings          = @($findings)
        Failures          = @($failures)
    }

    Write-Host ""
    Write-Host "Conjur secret-value audit complete."
    Write-Host "Variables enumerated : $($report.TotalVariables)"
    Write-Host "Values inspected     : $($report.InspectedValues)"
    Write-Host "Suspicious values    : $($report.SuspiciousValues)"
    Write-Host "Retrieval failures   : $($report.RetrievalFailures)"
    Write-Host "Secret values were not printed or written to the report."

    if ($findings.Count -gt 0) {
        Write-Host ""
        Write-Host "Suspicious values (value omitted):"
        $findings |
            Sort-Object -Property Confidence, VariableId |
            Format-Table -Property VariableId, Confidence, Reason -AutoSize |
            Out-Host
    }

    if ($failures.Count -gt 0) {
        Write-Host ""
        Write-Host "Variables that could not be fully inspected:"
        $failures |
            Sort-Object -Property VariableId |
            Format-Table -Property VariableId, ErrorCode, ExitCode -AutoSize |
            Out-Host
    }

    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
        $parent = Split-Path -Parent $fullOutputPath
        if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw "OutputPath parent directory does not exist."
        }
        if ((Test-Path -LiteralPath $fullOutputPath) -and -not $Force) {
            throw "OutputPath already exists. Use -Force to replace the redacted report."
        }

        $json = $report | ConvertTo-Json -Depth 8
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($fullOutputPath, $json, $utf8NoBom)
        Write-Host "Redacted report      : $fullOutputPath"
    }

    if ($failures.Count -gt 0) {
        exit 3
    }
    if ($findings.Count -gt 0) {
        exit 2
    }
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
 -or
        $candidate -match '^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}
    if ($candidate -match $pathPattern) {
        if ($candidate -match '(?:^|[\\/])(password|passwd|pwd|username|user|token|api[-_]?key|secret|client[-_]?secret|private[-_]?key|access[-_]?key|credential|credentials)$') {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'path_with_secret_field_suffix'
            }
        }

        $separatorCount = ([System.Text.RegularExpressions.Regex]::Matches($candidate, '[./\\]')).Count
        if ($separatorCount -ge 3) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'hierarchical_reference_shape'
            }
        }
    }

    return $null
}

function Test-MeetsMinimumConfidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Confidence,
        [Parameter(Mandatory = $true)]
        [string]$Minimum
    )

    if ($Minimum -eq 'High') {
        return $Confidence -eq 'High'
    }
    return $Confidence -eq 'High' -or $Confidence -eq 'Medium'
}

function Invoke-ClassifierSelfTest {
    $references = New-OrdinalStringSet
    $normalizedReferences = New-OrdinalStringSet

    foreach ($reference in @(
        'prod/service/password',
        'RH/value/value/value/password',
        'acme:variable:prod/service/token'
    )) {
        [void]$references.Add($reference)
        [void]$normalizedReferences.Add((Normalize-ReferenceShape -Value $reference))
    }

    $cases = @(
        [pscustomobject]@{ Name = 'exact known path'; Value = 'prod/service/password'; Confidence = 'High'; Reason = 'exact_known_variable_reference' },
        [pscustomobject]@{ Name = 'normalized dot path'; Value = 'RH.value.value.value/password'; Confidence = 'High'; Reason = 'normalized_known_variable_reference' },
        [pscustomobject]@{ Name = 'reference URI'; Value = 'conjur://prod/service/password'; Confidence = 'High'; Reason = 'secret_reference_uri' },
        [pscustomobject]@{ Name = 'dot notation shape'; Value = 'other.team.database/password'; Confidence = 'Medium'; Reason = 'dot_notation_reference_shape' },
        [pscustomobject]@{ Name = 'credential suffix'; Value = 'other/service/password'; Confidence = 'Medium'; Reason = 'path_with_secret_field_suffix' },
        [pscustomobject]@{ Name = 'hierarchical path'; Value = 'other/service/env/region/value'; Confidence = 'Medium'; Reason = 'hierarchical_reference_shape' },
        [pscustomobject]@{ Name = 'ordinary password'; Value = 'correct-horse-battery-staple'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'URL'; Value = 'https://example.com/a/b/c'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'JSON'; Value = '{"password":"not-a-reference"}'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'connection string'; Value = 'Server=db;Password=example'; Confidence = $null; Reason = $null }
    )

    foreach ($case in $cases) {
        $actual = Test-SecretValueShape -Value $case.Value -KnownReferences $references -KnownNormalizedReferences $normalizedReferences

        if ($null -eq $case.Confidence) {
            if ($null -ne $actual) {
                throw "Self-test '$($case.Name)' unexpectedly classified as $($actual.Confidence)/$($actual.Reason)."
            }
            continue
        }

        if ($null -eq $actual) {
            throw "Self-test '$($case.Name)' unexpectedly produced no finding."
        }
        if ($actual.Confidence -ne $case.Confidence -or $actual.Reason -ne $case.Reason) {
            throw "Self-test '$($case.Name)' returned $($actual.Confidence)/$($actual.Reason), expected $($case.Confidence)/$($case.Reason)."
        }
    }

    Write-Host "Self-test passed: $($cases.Count) classifier cases."
}

if ($SelfTest) {
    Invoke-ClassifierSelfTest
    exit 0
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or later is required."
    }

    $resolvedConjur = Resolve-ConjurExecutable -Path $ConjurPath

    $versionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--version') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($versionResult.ExitCode -ne 0) {
        throw "Unable to read the Conjur CLI version."
    }

    $versionMatch = [System.Text.RegularExpressions.Regex]::Match($versionResult.Stdout, '(?<![0-9])([0-9]+)\.([0-9]+)\.([0-9]+)')
    if (-not $versionMatch.Success) {
        throw "Unable to parse the Conjur CLI version."
    }

    $majorVersion = [int]$versionMatch.Groups[1].Value
    if ($majorVersion -ne 9 -and -not $AllowUnsupportedVersion) {
        throw "This audit is qualified for Conjur CLI 9.x. Re-run with -AllowUnsupportedVersion only after reviewing CLI output compatibility."
    }

    $sessionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'whoami', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($sessionResult.ExitCode -ne 0) {
        throw "Conjur session verification failed. Authenticate with the approved vendor flow before auditing."
    }
    $null = ConvertFrom-ConjurJson -Json $sessionResult.Stdout -Context 'conjur whoami'

    $listResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'list', '--kind', 'variable', '--limit=-1', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($listResult.ExitCode -ne 0) {
        throw "Conjur variable enumeration failed."
    }

    $listed = ConvertFrom-ConjurJson -Json $listResult.Stdout -Context 'conjur list'
    if ($null -eq $listed) {
        $resources = @()
    }
    else {
        $resources = @($listed)
    }

    $records = New-Object 'System.Collections.Generic.List[object]'
    $resourceIds = New-OrdinalStringSet
    $knownReferences = New-OrdinalStringSet
    $knownNormalizedReferences = New-OrdinalStringSet

    foreach ($resource in $resources) {
        if ($null -eq $resource) {
            throw "Conjur list returned a null variable entry; refusing a partial audit."
        }

        $idProperty = $resource.PSObject.Properties['id']
        if ($null -eq $idProperty -or [string]::IsNullOrWhiteSpace([string]$idProperty.Value)) {
            throw "Conjur list returned a variable entry without an id; refusing a partial audit."
        }

        $resourceId = [string]$idProperty.Value
        if (-not $resourceIds.Add($resourceId)) {
            continue
        }

        $variableId = ConvertFrom-ResourceIdToVariableId -ResourceId $resourceId
        [void]$knownReferences.Add($resourceId)
        [void]$knownReferences.Add($variableId)
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $resourceId))
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $variableId))

        $records.Add([pscustomobject][ordered]@{
            ResourceId = $resourceId
            VariableId = $variableId
        })
    }

    $orderedRecords = @($records | Sort-Object -Property VariableId, ResourceId)
    $findings = New-Object 'System.Collections.Generic.List[object]'
    $failures = New-Object 'System.Collections.Generic.List[object]'
    $inspected = 0

    for ($index = 0; $index -lt $orderedRecords.Count; $index++) {
        $record = $orderedRecords[$index]
        $position = $index + 1
        $percent = 100
        if ($orderedRecords.Count -gt 0) {
            $percent = [int](($position / [double]$orderedRecords.Count) * 100)
        }
        Write-Progress -Activity 'Auditing Conjur variable values' -Status "$position of $($orderedRecords.Count)" -PercentComplete $percent

        $getResult = $null
        $secretObject = $null
        $secretValue = $null

        try {
            $getResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'variable', 'get', '--id', $record.VariableId, '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
            if ($getResult.ExitCode -ne 0) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'retrieval_failed'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            try {
                $secretObject = ConvertFrom-ConjurJson -Json $getResult.Stdout -Context 'conjur variable get'
            }
            catch {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'invalid_secret_json'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $valueProperty = $secretObject.PSObject.Properties['value']
            if ($null -eq $valueProperty) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'missing_value_field'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $secretValue = [string]$valueProperty.Value
            $inspected++

            $classification = Test-SecretValueShape -Value $secretValue -KnownReferences $knownReferences -KnownNormalizedReferences $knownNormalizedReferences
            if ($null -ne $classification -and (Test-MeetsMinimumConfidence -Confidence $classification.Confidence -Minimum $MinimumConfidence)) {
                $findings.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    Confidence = $classification.Confidence
                    Reason     = $classification.Reason
                })
            }
        }
        finally {
            $secretValue = $null
            $secretObject = $null
            $getResult = $null
        }
    }

    Write-Progress -Activity 'Auditing Conjur variable values' -Completed

    $report = [pscustomobject][ordered]@{
        SchemaVersion     = 1
        GeneratedAtUtc    = [DateTime]::UtcNow.ToString('o')
        ConjurVersion     = $versionMatch.Value
        TotalVariables    = $orderedRecords.Count
        InspectedValues   = $inspected
        SuspiciousValues  = $findings.Count
        RetrievalFailures = $failures.Count
        MinimumConfidence = $MinimumConfidence
        Findings          = @($findings)
        Failures          = @($failures)
    }

    Write-Host ""
    Write-Host "Conjur secret-value audit complete."
    Write-Host "Variables enumerated : $($report.TotalVariables)"
    Write-Host "Values inspected     : $($report.InspectedValues)"
    Write-Host "Suspicious values    : $($report.SuspiciousValues)"
    Write-Host "Retrieval failures   : $($report.RetrievalFailures)"
    Write-Host "Secret values were not printed or written to the report."

    if ($findings.Count -gt 0) {
        Write-Host ""
        Write-Host "Suspicious values (value omitted):"
        $findings |
            Sort-Object -Property Confidence, VariableId |
            Format-Table -Property VariableId, Confidence, Reason -AutoSize |
            Out-Host
    }

    if ($failures.Count -gt 0) {
        Write-Host ""
        Write-Host "Variables that could not be fully inspected:"
        $failures |
            Sort-Object -Property VariableId |
            Format-Table -Property VariableId, ErrorCode, ExitCode -AutoSize |
            Out-Host
    }

    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
        $parent = Split-Path -Parent $fullOutputPath
        if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw "OutputPath parent directory does not exist."
        }
        if ((Test-Path -LiteralPath $fullOutputPath) -and -not $Force) {
            throw "OutputPath already exists. Use -Force to replace the redacted report."
        }

        $json = $report | ConvertTo-Json -Depth 8
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($fullOutputPath, $json, $utf8NoBom)
        Write-Host "Redacted report      : $fullOutputPath"
    }

    if ($failures.Count -gt 0) {
        exit 3
    }
    if ($findings.Count -gt 0) {
        exit 2
    }
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}

    ) {
        return $null
    }

    $secretFieldSuffix = '(password|passwd|pwd|username|user|token|api[-_]?key|secret|client[-_]?secret|private[-_]?key|access[-_]?key|credential|credentials)'
    $dotReferencePattern = '^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,}(?:[\\/][A-Za-z0-9_.@-]+(?:[\\/][A-Za-z0-9_.@-]+)*)?
    if ($candidate -match $pathPattern) {
        if ($candidate -match '(?:^|[\\/])(password|passwd|pwd|username|user|token|api[-_]?key|secret|client[-_]?secret|private[-_]?key|access[-_]?key|credential|credentials)$') {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'path_with_secret_field_suffix'
            }
        }

        $separatorCount = ([System.Text.RegularExpressions.Regex]::Matches($candidate, '[./\\]')).Count
        if ($separatorCount -ge 3) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'hierarchical_reference_shape'
            }
        }
    }

    return $null
}

function Test-MeetsMinimumConfidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Confidence,
        [Parameter(Mandatory = $true)]
        [string]$Minimum
    )

    if ($Minimum -eq 'High') {
        return $Confidence -eq 'High'
    }
    return $Confidence -eq 'High' -or $Confidence -eq 'Medium'
}

function Invoke-ClassifierSelfTest {
    $references = New-OrdinalStringSet
    $normalizedReferences = New-OrdinalStringSet

    foreach ($reference in @(
        'prod/service/password',
        'RH/value/value/value/password',
        'acme:variable:prod/service/token'
    )) {
        [void]$references.Add($reference)
        [void]$normalizedReferences.Add((Normalize-ReferenceShape -Value $reference))
    }

    $cases = @(
        [pscustomobject]@{ Name = 'exact known path'; Value = 'prod/service/password'; Confidence = 'High'; Reason = 'exact_known_variable_reference' },
        [pscustomobject]@{ Name = 'normalized dot path'; Value = 'RH.value.value.value/password'; Confidence = 'High'; Reason = 'normalized_known_variable_reference' },
        [pscustomobject]@{ Name = 'reference URI'; Value = 'conjur://prod/service/password'; Confidence = 'High'; Reason = 'secret_reference_uri' },
        [pscustomobject]@{ Name = 'dot notation shape'; Value = 'other.team.database/password'; Confidence = 'Medium'; Reason = 'dot_notation_reference_shape' },
        [pscustomobject]@{ Name = 'credential suffix'; Value = 'other/service/password'; Confidence = 'Medium'; Reason = 'path_with_secret_field_suffix' },
        [pscustomobject]@{ Name = 'hierarchical path'; Value = 'other/service/env/region/value'; Confidence = 'Medium'; Reason = 'hierarchical_reference_shape' },
        [pscustomobject]@{ Name = 'ordinary password'; Value = 'correct-horse-battery-staple'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'URL'; Value = 'https://example.com/a/b/c'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'JSON'; Value = '{"password":"not-a-reference"}'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'connection string'; Value = 'Server=db;Password=example'; Confidence = $null; Reason = $null }
    )

    foreach ($case in $cases) {
        $actual = Test-SecretValueShape -Value $case.Value -KnownReferences $references -KnownNormalizedReferences $normalizedReferences

        if ($null -eq $case.Confidence) {
            if ($null -ne $actual) {
                throw "Self-test '$($case.Name)' unexpectedly classified as $($actual.Confidence)/$($actual.Reason)."
            }
            continue
        }

        if ($null -eq $actual) {
            throw "Self-test '$($case.Name)' unexpectedly produced no finding."
        }
        if ($actual.Confidence -ne $case.Confidence -or $actual.Reason -ne $case.Reason) {
            throw "Self-test '$($case.Name)' returned $($actual.Confidence)/$($actual.Reason), expected $($case.Confidence)/$($case.Reason)."
        }
    }

    Write-Host "Self-test passed: $($cases.Count) classifier cases."
}

if ($SelfTest) {
    Invoke-ClassifierSelfTest
    exit 0
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or later is required."
    }

    $resolvedConjur = Resolve-ConjurExecutable -Path $ConjurPath

    $versionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--version') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($versionResult.ExitCode -ne 0) {
        throw "Unable to read the Conjur CLI version."
    }

    $versionMatch = [System.Text.RegularExpressions.Regex]::Match($versionResult.Stdout, '(?<![0-9])([0-9]+)\.([0-9]+)\.([0-9]+)')
    if (-not $versionMatch.Success) {
        throw "Unable to parse the Conjur CLI version."
    }

    $majorVersion = [int]$versionMatch.Groups[1].Value
    if ($majorVersion -ne 9 -and -not $AllowUnsupportedVersion) {
        throw "This audit is qualified for Conjur CLI 9.x. Re-run with -AllowUnsupportedVersion only after reviewing CLI output compatibility."
    }

    $sessionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'whoami', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($sessionResult.ExitCode -ne 0) {
        throw "Conjur session verification failed. Authenticate with the approved vendor flow before auditing."
    }
    $null = ConvertFrom-ConjurJson -Json $sessionResult.Stdout -Context 'conjur whoami'

    $listResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'list', '--kind', 'variable', '--limit=-1', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($listResult.ExitCode -ne 0) {
        throw "Conjur variable enumeration failed."
    }

    $listed = ConvertFrom-ConjurJson -Json $listResult.Stdout -Context 'conjur list'
    if ($null -eq $listed) {
        $resources = @()
    }
    else {
        $resources = @($listed)
    }

    $records = New-Object 'System.Collections.Generic.List[object]'
    $resourceIds = New-OrdinalStringSet
    $knownReferences = New-OrdinalStringSet
    $knownNormalizedReferences = New-OrdinalStringSet

    foreach ($resource in $resources) {
        if ($null -eq $resource) {
            throw "Conjur list returned a null variable entry; refusing a partial audit."
        }

        $idProperty = $resource.PSObject.Properties['id']
        if ($null -eq $idProperty -or [string]::IsNullOrWhiteSpace([string]$idProperty.Value)) {
            throw "Conjur list returned a variable entry without an id; refusing a partial audit."
        }

        $resourceId = [string]$idProperty.Value
        if (-not $resourceIds.Add($resourceId)) {
            continue
        }

        $variableId = ConvertFrom-ResourceIdToVariableId -ResourceId $resourceId
        [void]$knownReferences.Add($resourceId)
        [void]$knownReferences.Add($variableId)
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $resourceId))
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $variableId))

        $records.Add([pscustomobject][ordered]@{
            ResourceId = $resourceId
            VariableId = $variableId
        })
    }

    $orderedRecords = @($records | Sort-Object -Property VariableId, ResourceId)
    $findings = New-Object 'System.Collections.Generic.List[object]'
    $failures = New-Object 'System.Collections.Generic.List[object]'
    $inspected = 0

    for ($index = 0; $index -lt $orderedRecords.Count; $index++) {
        $record = $orderedRecords[$index]
        $position = $index + 1
        $percent = 100
        if ($orderedRecords.Count -gt 0) {
            $percent = [int](($position / [double]$orderedRecords.Count) * 100)
        }
        Write-Progress -Activity 'Auditing Conjur variable values' -Status "$position of $($orderedRecords.Count)" -PercentComplete $percent

        $getResult = $null
        $secretObject = $null
        $secretValue = $null

        try {
            $getResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'variable', 'get', '--id', $record.VariableId, '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
            if ($getResult.ExitCode -ne 0) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'retrieval_failed'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            try {
                $secretObject = ConvertFrom-ConjurJson -Json $getResult.Stdout -Context 'conjur variable get'
            }
            catch {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'invalid_secret_json'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $valueProperty = $secretObject.PSObject.Properties['value']
            if ($null -eq $valueProperty) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'missing_value_field'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $secretValue = [string]$valueProperty.Value
            $inspected++

            $classification = Test-SecretValueShape -Value $secretValue -KnownReferences $knownReferences -KnownNormalizedReferences $knownNormalizedReferences
            if ($null -ne $classification -and (Test-MeetsMinimumConfidence -Confidence $classification.Confidence -Minimum $MinimumConfidence)) {
                $findings.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    Confidence = $classification.Confidence
                    Reason     = $classification.Reason
                })
            }
        }
        finally {
            $secretValue = $null
            $secretObject = $null
            $getResult = $null
        }
    }

    Write-Progress -Activity 'Auditing Conjur variable values' -Completed

    $report = [pscustomobject][ordered]@{
        SchemaVersion     = 1
        GeneratedAtUtc    = [DateTime]::UtcNow.ToString('o')
        ConjurVersion     = $versionMatch.Value
        TotalVariables    = $orderedRecords.Count
        InspectedValues   = $inspected
        SuspiciousValues  = $findings.Count
        RetrievalFailures = $failures.Count
        MinimumConfidence = $MinimumConfidence
        Findings          = @($findings)
        Failures          = @($failures)
    }

    Write-Host ""
    Write-Host "Conjur secret-value audit complete."
    Write-Host "Variables enumerated : $($report.TotalVariables)"
    Write-Host "Values inspected     : $($report.InspectedValues)"
    Write-Host "Suspicious values    : $($report.SuspiciousValues)"
    Write-Host "Retrieval failures   : $($report.RetrievalFailures)"
    Write-Host "Secret values were not printed or written to the report."

    if ($findings.Count -gt 0) {
        Write-Host ""
        Write-Host "Suspicious values (value omitted):"
        $findings |
            Sort-Object -Property Confidence, VariableId |
            Format-Table -Property VariableId, Confidence, Reason -AutoSize |
            Out-Host
    }

    if ($failures.Count -gt 0) {
        Write-Host ""
        Write-Host "Variables that could not be fully inspected:"
        $failures |
            Sort-Object -Property VariableId |
            Format-Table -Property VariableId, ErrorCode, ExitCode -AutoSize |
            Out-Host
    }

    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
        $parent = Split-Path -Parent $fullOutputPath
        if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw "OutputPath parent directory does not exist."
        }
        if ((Test-Path -LiteralPath $fullOutputPath) -and -not $Force) {
            throw "OutputPath already exists. Use -Force to replace the redacted report."
        }

        $json = $report | ConvertTo-Json -Depth 8
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($fullOutputPath, $json, $utf8NoBom)
        Write-Host "Redacted report      : $fullOutputPath"
    }

    if ($failures.Count -gt 0) {
        exit 3
    }
    if ($findings.Count -gt 0) {
        exit 2
    }
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}

    if ($candidate -match $dotReferencePattern) {
        if (
            $candidate.Contains('/') -or
            $candidate.Contains('\') -or
            $candidate -match ("\." + $secretFieldSuffix + '
    if ($candidate -match $pathPattern) {
        if ($candidate -match '(?:^|[\\/])(password|passwd|pwd|username|user|token|api[-_]?key|secret|client[-_]?secret|private[-_]?key|access[-_]?key|credential|credentials)$') {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'path_with_secret_field_suffix'
            }
        }

        $separatorCount = ([System.Text.RegularExpressions.Regex]::Matches($candidate, '[./\\]')).Count
        if ($separatorCount -ge 3) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'hierarchical_reference_shape'
            }
        }
    }

    return $null
}

function Test-MeetsMinimumConfidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Confidence,
        [Parameter(Mandatory = $true)]
        [string]$Minimum
    )

    if ($Minimum -eq 'High') {
        return $Confidence -eq 'High'
    }
    return $Confidence -eq 'High' -or $Confidence -eq 'Medium'
}

function Invoke-ClassifierSelfTest {
    $references = New-OrdinalStringSet
    $normalizedReferences = New-OrdinalStringSet

    foreach ($reference in @(
        'prod/service/password',
        'RH/value/value/value/password',
        'acme:variable:prod/service/token'
    )) {
        [void]$references.Add($reference)
        [void]$normalizedReferences.Add((Normalize-ReferenceShape -Value $reference))
    }

    $cases = @(
        [pscustomobject]@{ Name = 'exact known path'; Value = 'prod/service/password'; Confidence = 'High'; Reason = 'exact_known_variable_reference' },
        [pscustomobject]@{ Name = 'normalized dot path'; Value = 'RH.value.value.value/password'; Confidence = 'High'; Reason = 'normalized_known_variable_reference' },
        [pscustomobject]@{ Name = 'reference URI'; Value = 'conjur://prod/service/password'; Confidence = 'High'; Reason = 'secret_reference_uri' },
        [pscustomobject]@{ Name = 'dot notation shape'; Value = 'other.team.database/password'; Confidence = 'Medium'; Reason = 'dot_notation_reference_shape' },
        [pscustomobject]@{ Name = 'credential suffix'; Value = 'other/service/password'; Confidence = 'Medium'; Reason = 'path_with_secret_field_suffix' },
        [pscustomobject]@{ Name = 'hierarchical path'; Value = 'other/service/env/region/value'; Confidence = 'Medium'; Reason = 'hierarchical_reference_shape' },
        [pscustomobject]@{ Name = 'ordinary password'; Value = 'correct-horse-battery-staple'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'URL'; Value = 'https://example.com/a/b/c'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'JSON'; Value = '{"password":"not-a-reference"}'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'connection string'; Value = 'Server=db;Password=example'; Confidence = $null; Reason = $null }
    )

    foreach ($case in $cases) {
        $actual = Test-SecretValueShape -Value $case.Value -KnownReferences $references -KnownNormalizedReferences $normalizedReferences

        if ($null -eq $case.Confidence) {
            if ($null -ne $actual) {
                throw "Self-test '$($case.Name)' unexpectedly classified as $($actual.Confidence)/$($actual.Reason)."
            }
            continue
        }

        if ($null -eq $actual) {
            throw "Self-test '$($case.Name)' unexpectedly produced no finding."
        }
        if ($actual.Confidence -ne $case.Confidence -or $actual.Reason -ne $case.Reason) {
            throw "Self-test '$($case.Name)' returned $($actual.Confidence)/$($actual.Reason), expected $($case.Confidence)/$($case.Reason)."
        }
    }

    Write-Host "Self-test passed: $($cases.Count) classifier cases."
}

if ($SelfTest) {
    Invoke-ClassifierSelfTest
    exit 0
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or later is required."
    }

    $resolvedConjur = Resolve-ConjurExecutable -Path $ConjurPath

    $versionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--version') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($versionResult.ExitCode -ne 0) {
        throw "Unable to read the Conjur CLI version."
    }

    $versionMatch = [System.Text.RegularExpressions.Regex]::Match($versionResult.Stdout, '(?<![0-9])([0-9]+)\.([0-9]+)\.([0-9]+)')
    if (-not $versionMatch.Success) {
        throw "Unable to parse the Conjur CLI version."
    }

    $majorVersion = [int]$versionMatch.Groups[1].Value
    if ($majorVersion -ne 9 -and -not $AllowUnsupportedVersion) {
        throw "This audit is qualified for Conjur CLI 9.x. Re-run with -AllowUnsupportedVersion only after reviewing CLI output compatibility."
    }

    $sessionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'whoami', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($sessionResult.ExitCode -ne 0) {
        throw "Conjur session verification failed. Authenticate with the approved vendor flow before auditing."
    }
    $null = ConvertFrom-ConjurJson -Json $sessionResult.Stdout -Context 'conjur whoami'

    $listResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'list', '--kind', 'variable', '--limit=-1', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($listResult.ExitCode -ne 0) {
        throw "Conjur variable enumeration failed."
    }

    $listed = ConvertFrom-ConjurJson -Json $listResult.Stdout -Context 'conjur list'
    if ($null -eq $listed) {
        $resources = @()
    }
    else {
        $resources = @($listed)
    }

    $records = New-Object 'System.Collections.Generic.List[object]'
    $resourceIds = New-OrdinalStringSet
    $knownReferences = New-OrdinalStringSet
    $knownNormalizedReferences = New-OrdinalStringSet

    foreach ($resource in $resources) {
        if ($null -eq $resource) {
            throw "Conjur list returned a null variable entry; refusing a partial audit."
        }

        $idProperty = $resource.PSObject.Properties['id']
        if ($null -eq $idProperty -or [string]::IsNullOrWhiteSpace([string]$idProperty.Value)) {
            throw "Conjur list returned a variable entry without an id; refusing a partial audit."
        }

        $resourceId = [string]$idProperty.Value
        if (-not $resourceIds.Add($resourceId)) {
            continue
        }

        $variableId = ConvertFrom-ResourceIdToVariableId -ResourceId $resourceId
        [void]$knownReferences.Add($resourceId)
        [void]$knownReferences.Add($variableId)
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $resourceId))
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $variableId))

        $records.Add([pscustomobject][ordered]@{
            ResourceId = $resourceId
            VariableId = $variableId
        })
    }

    $orderedRecords = @($records | Sort-Object -Property VariableId, ResourceId)
    $findings = New-Object 'System.Collections.Generic.List[object]'
    $failures = New-Object 'System.Collections.Generic.List[object]'
    $inspected = 0

    for ($index = 0; $index -lt $orderedRecords.Count; $index++) {
        $record = $orderedRecords[$index]
        $position = $index + 1
        $percent = 100
        if ($orderedRecords.Count -gt 0) {
            $percent = [int](($position / [double]$orderedRecords.Count) * 100)
        }
        Write-Progress -Activity 'Auditing Conjur variable values' -Status "$position of $($orderedRecords.Count)" -PercentComplete $percent

        $getResult = $null
        $secretObject = $null
        $secretValue = $null

        try {
            $getResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'variable', 'get', '--id', $record.VariableId, '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
            if ($getResult.ExitCode -ne 0) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'retrieval_failed'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            try {
                $secretObject = ConvertFrom-ConjurJson -Json $getResult.Stdout -Context 'conjur variable get'
            }
            catch {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'invalid_secret_json'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $valueProperty = $secretObject.PSObject.Properties['value']
            if ($null -eq $valueProperty) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'missing_value_field'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $secretValue = [string]$valueProperty.Value
            $inspected++

            $classification = Test-SecretValueShape -Value $secretValue -KnownReferences $knownReferences -KnownNormalizedReferences $knownNormalizedReferences
            if ($null -ne $classification -and (Test-MeetsMinimumConfidence -Confidence $classification.Confidence -Minimum $MinimumConfidence)) {
                $findings.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    Confidence = $classification.Confidence
                    Reason     = $classification.Reason
                })
            }
        }
        finally {
            $secretValue = $null
            $secretObject = $null
            $getResult = $null
        }
    }

    Write-Progress -Activity 'Auditing Conjur variable values' -Completed

    $report = [pscustomobject][ordered]@{
        SchemaVersion     = 1
        GeneratedAtUtc    = [DateTime]::UtcNow.ToString('o')
        ConjurVersion     = $versionMatch.Value
        TotalVariables    = $orderedRecords.Count
        InspectedValues   = $inspected
        SuspiciousValues  = $findings.Count
        RetrievalFailures = $failures.Count
        MinimumConfidence = $MinimumConfidence
        Findings          = @($findings)
        Failures          = @($failures)
    }

    Write-Host ""
    Write-Host "Conjur secret-value audit complete."
    Write-Host "Variables enumerated : $($report.TotalVariables)"
    Write-Host "Values inspected     : $($report.InspectedValues)"
    Write-Host "Suspicious values    : $($report.SuspiciousValues)"
    Write-Host "Retrieval failures   : $($report.RetrievalFailures)"
    Write-Host "Secret values were not printed or written to the report."

    if ($findings.Count -gt 0) {
        Write-Host ""
        Write-Host "Suspicious values (value omitted):"
        $findings |
            Sort-Object -Property Confidence, VariableId |
            Format-Table -Property VariableId, Confidence, Reason -AutoSize |
            Out-Host
    }

    if ($failures.Count -gt 0) {
        Write-Host ""
        Write-Host "Variables that could not be fully inspected:"
        $failures |
            Sort-Object -Property VariableId |
            Format-Table -Property VariableId, ErrorCode, ExitCode -AutoSize |
            Out-Host
    }

    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
        $parent = Split-Path -Parent $fullOutputPath
        if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw "OutputPath parent directory does not exist."
        }
        if ((Test-Path -LiteralPath $fullOutputPath) -and -not $Force) {
            throw "OutputPath already exists. Use -Force to replace the redacted report."
        }

        $json = $report | ConvertTo-Json -Depth 8
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($fullOutputPath, $json, $utf8NoBom)
        Write-Host "Redacted report      : $fullOutputPath"
    }

    if ($failures.Count -gt 0) {
        exit 3
    }
    if ($findings.Count -gt 0) {
        exit 2
    }
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
)
        ) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'dot_notation_reference_shape'
            }
        }
    }

    $pathPattern = '^[A-Za-z0-9_.@-]+(?:[\\/][A-Za-z0-9_.@-]+)+
    if ($candidate -match $pathPattern) {
        if ($candidate -match '(?:^|[\\/])(password|passwd|pwd|username|user|token|api[-_]?key|secret|client[-_]?secret|private[-_]?key|access[-_]?key|credential|credentials)$') {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'path_with_secret_field_suffix'
            }
        }

        $separatorCount = ([System.Text.RegularExpressions.Regex]::Matches($candidate, '[./\\]')).Count
        if ($separatorCount -ge 3) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'hierarchical_reference_shape'
            }
        }
    }

    return $null
}

function Test-MeetsMinimumConfidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Confidence,
        [Parameter(Mandatory = $true)]
        [string]$Minimum
    )

    if ($Minimum -eq 'High') {
        return $Confidence -eq 'High'
    }
    return $Confidence -eq 'High' -or $Confidence -eq 'Medium'
}

function Invoke-ClassifierSelfTest {
    $references = New-OrdinalStringSet
    $normalizedReferences = New-OrdinalStringSet

    foreach ($reference in @(
        'prod/service/password',
        'RH/value/value/value/password',
        'acme:variable:prod/service/token'
    )) {
        [void]$references.Add($reference)
        [void]$normalizedReferences.Add((Normalize-ReferenceShape -Value $reference))
    }

    $cases = @(
        [pscustomobject]@{ Name = 'exact known path'; Value = 'prod/service/password'; Confidence = 'High'; Reason = 'exact_known_variable_reference' },
        [pscustomobject]@{ Name = 'normalized dot path'; Value = 'RH.value.value.value/password'; Confidence = 'High'; Reason = 'normalized_known_variable_reference' },
        [pscustomobject]@{ Name = 'reference URI'; Value = 'conjur://prod/service/password'; Confidence = 'High'; Reason = 'secret_reference_uri' },
        [pscustomobject]@{ Name = 'dot notation shape'; Value = 'other.team.database/password'; Confidence = 'Medium'; Reason = 'dot_notation_reference_shape' },
        [pscustomobject]@{ Name = 'credential suffix'; Value = 'other/service/password'; Confidence = 'Medium'; Reason = 'path_with_secret_field_suffix' },
        [pscustomobject]@{ Name = 'hierarchical path'; Value = 'other/service/env/region/value'; Confidence = 'Medium'; Reason = 'hierarchical_reference_shape' },
        [pscustomobject]@{ Name = 'ordinary password'; Value = 'correct-horse-battery-staple'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'URL'; Value = 'https://example.com/a/b/c'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'JSON'; Value = '{"password":"not-a-reference"}'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'connection string'; Value = 'Server=db;Password=example'; Confidence = $null; Reason = $null }
    )

    foreach ($case in $cases) {
        $actual = Test-SecretValueShape -Value $case.Value -KnownReferences $references -KnownNormalizedReferences $normalizedReferences

        if ($null -eq $case.Confidence) {
            if ($null -ne $actual) {
                throw "Self-test '$($case.Name)' unexpectedly classified as $($actual.Confidence)/$($actual.Reason)."
            }
            continue
        }

        if ($null -eq $actual) {
            throw "Self-test '$($case.Name)' unexpectedly produced no finding."
        }
        if ($actual.Confidence -ne $case.Confidence -or $actual.Reason -ne $case.Reason) {
            throw "Self-test '$($case.Name)' returned $($actual.Confidence)/$($actual.Reason), expected $($case.Confidence)/$($case.Reason)."
        }
    }

    Write-Host "Self-test passed: $($cases.Count) classifier cases."
}

if ($SelfTest) {
    Invoke-ClassifierSelfTest
    exit 0
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or later is required."
    }

    $resolvedConjur = Resolve-ConjurExecutable -Path $ConjurPath

    $versionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--version') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($versionResult.ExitCode -ne 0) {
        throw "Unable to read the Conjur CLI version."
    }

    $versionMatch = [System.Text.RegularExpressions.Regex]::Match($versionResult.Stdout, '(?<![0-9])([0-9]+)\.([0-9]+)\.([0-9]+)')
    if (-not $versionMatch.Success) {
        throw "Unable to parse the Conjur CLI version."
    }

    $majorVersion = [int]$versionMatch.Groups[1].Value
    if ($majorVersion -ne 9 -and -not $AllowUnsupportedVersion) {
        throw "This audit is qualified for Conjur CLI 9.x. Re-run with -AllowUnsupportedVersion only after reviewing CLI output compatibility."
    }

    $sessionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'whoami', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($sessionResult.ExitCode -ne 0) {
        throw "Conjur session verification failed. Authenticate with the approved vendor flow before auditing."
    }
    $null = ConvertFrom-ConjurJson -Json $sessionResult.Stdout -Context 'conjur whoami'

    $listResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'list', '--kind', 'variable', '--limit=-1', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($listResult.ExitCode -ne 0) {
        throw "Conjur variable enumeration failed."
    }

    $listed = ConvertFrom-ConjurJson -Json $listResult.Stdout -Context 'conjur list'
    if ($null -eq $listed) {
        $resources = @()
    }
    else {
        $resources = @($listed)
    }

    $records = New-Object 'System.Collections.Generic.List[object]'
    $resourceIds = New-OrdinalStringSet
    $knownReferences = New-OrdinalStringSet
    $knownNormalizedReferences = New-OrdinalStringSet

    foreach ($resource in $resources) {
        if ($null -eq $resource) {
            throw "Conjur list returned a null variable entry; refusing a partial audit."
        }

        $idProperty = $resource.PSObject.Properties['id']
        if ($null -eq $idProperty -or [string]::IsNullOrWhiteSpace([string]$idProperty.Value)) {
            throw "Conjur list returned a variable entry without an id; refusing a partial audit."
        }

        $resourceId = [string]$idProperty.Value
        if (-not $resourceIds.Add($resourceId)) {
            continue
        }

        $variableId = ConvertFrom-ResourceIdToVariableId -ResourceId $resourceId
        [void]$knownReferences.Add($resourceId)
        [void]$knownReferences.Add($variableId)
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $resourceId))
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $variableId))

        $records.Add([pscustomobject][ordered]@{
            ResourceId = $resourceId
            VariableId = $variableId
        })
    }

    $orderedRecords = @($records | Sort-Object -Property VariableId, ResourceId)
    $findings = New-Object 'System.Collections.Generic.List[object]'
    $failures = New-Object 'System.Collections.Generic.List[object]'
    $inspected = 0

    for ($index = 0; $index -lt $orderedRecords.Count; $index++) {
        $record = $orderedRecords[$index]
        $position = $index + 1
        $percent = 100
        if ($orderedRecords.Count -gt 0) {
            $percent = [int](($position / [double]$orderedRecords.Count) * 100)
        }
        Write-Progress -Activity 'Auditing Conjur variable values' -Status "$position of $($orderedRecords.Count)" -PercentComplete $percent

        $getResult = $null
        $secretObject = $null
        $secretValue = $null

        try {
            $getResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'variable', 'get', '--id', $record.VariableId, '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
            if ($getResult.ExitCode -ne 0) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'retrieval_failed'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            try {
                $secretObject = ConvertFrom-ConjurJson -Json $getResult.Stdout -Context 'conjur variable get'
            }
            catch {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'invalid_secret_json'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $valueProperty = $secretObject.PSObject.Properties['value']
            if ($null -eq $valueProperty) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'missing_value_field'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $secretValue = [string]$valueProperty.Value
            $inspected++

            $classification = Test-SecretValueShape -Value $secretValue -KnownReferences $knownReferences -KnownNormalizedReferences $knownNormalizedReferences
            if ($null -ne $classification -and (Test-MeetsMinimumConfidence -Confidence $classification.Confidence -Minimum $MinimumConfidence)) {
                $findings.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    Confidence = $classification.Confidence
                    Reason     = $classification.Reason
                })
            }
        }
        finally {
            $secretValue = $null
            $secretObject = $null
            $getResult = $null
        }
    }

    Write-Progress -Activity 'Auditing Conjur variable values' -Completed

    $report = [pscustomobject][ordered]@{
        SchemaVersion     = 1
        GeneratedAtUtc    = [DateTime]::UtcNow.ToString('o')
        ConjurVersion     = $versionMatch.Value
        TotalVariables    = $orderedRecords.Count
        InspectedValues   = $inspected
        SuspiciousValues  = $findings.Count
        RetrievalFailures = $failures.Count
        MinimumConfidence = $MinimumConfidence
        Findings          = @($findings)
        Failures          = @($failures)
    }

    Write-Host ""
    Write-Host "Conjur secret-value audit complete."
    Write-Host "Variables enumerated : $($report.TotalVariables)"
    Write-Host "Values inspected     : $($report.InspectedValues)"
    Write-Host "Suspicious values    : $($report.SuspiciousValues)"
    Write-Host "Retrieval failures   : $($report.RetrievalFailures)"
    Write-Host "Secret values were not printed or written to the report."

    if ($findings.Count -gt 0) {
        Write-Host ""
        Write-Host "Suspicious values (value omitted):"
        $findings |
            Sort-Object -Property Confidence, VariableId |
            Format-Table -Property VariableId, Confidence, Reason -AutoSize |
            Out-Host
    }

    if ($failures.Count -gt 0) {
        Write-Host ""
        Write-Host "Variables that could not be fully inspected:"
        $failures |
            Sort-Object -Property VariableId |
            Format-Table -Property VariableId, ErrorCode, ExitCode -AutoSize |
            Out-Host
    }

    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
        $parent = Split-Path -Parent $fullOutputPath
        if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw "OutputPath parent directory does not exist."
        }
        if ((Test-Path -LiteralPath $fullOutputPath) -and -not $Force) {
            throw "OutputPath already exists. Use -Force to replace the redacted report."
        }

        $json = $report | ConvertTo-Json -Depth 8
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($fullOutputPath, $json, $utf8NoBom)
        Write-Host "Redacted report      : $fullOutputPath"
    }

    if ($failures.Count -gt 0) {
        exit 3
    }
    if ($findings.Count -gt 0) {
        exit 2
    }
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}

    if ($candidate -match $pathPattern) {
        if ($candidate -match '(?:^|[\\/])(password|passwd|pwd|username|user|token|api[-_]?key|secret|client[-_]?secret|private[-_]?key|access[-_]?key|credential|credentials)$') {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'path_with_secret_field_suffix'
            }
        }

        $separatorCount = ([System.Text.RegularExpressions.Regex]::Matches($candidate, '[./\\]')).Count
        if ($separatorCount -ge 3) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'hierarchical_reference_shape'
            }
        }
    }

    return $null
}

function Test-MeetsMinimumConfidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Confidence,
        [Parameter(Mandatory = $true)]
        [string]$Minimum
    )

    if ($Minimum -eq 'High') {
        return $Confidence -eq 'High'
    }
    return $Confidence -eq 'High' -or $Confidence -eq 'Medium'
}

function Invoke-ClassifierSelfTest {
    $references = New-OrdinalStringSet
    $normalizedReferences = New-OrdinalStringSet

    foreach ($reference in @(
        'prod/service/password',
        'RH/value/value/value/password',
        'acme:variable:prod/service/token'
    )) {
        [void]$references.Add($reference)
        [void]$normalizedReferences.Add((Normalize-ReferenceShape -Value $reference))
    }

    $cases = @(
        [pscustomobject]@{ Name = 'exact known path'; Value = 'prod/service/password'; Confidence = 'High'; Reason = 'exact_known_variable_reference' },
        [pscustomobject]@{ Name = 'normalized dot path'; Value = 'RH.value.value.value/password'; Confidence = 'High'; Reason = 'normalized_known_variable_reference' },
        [pscustomobject]@{ Name = 'reference URI'; Value = 'conjur://prod/service/password'; Confidence = 'High'; Reason = 'secret_reference_uri' },
        [pscustomobject]@{ Name = 'dot notation shape'; Value = 'other.team.database/password'; Confidence = 'Medium'; Reason = 'dot_notation_reference_shape' },
        [pscustomobject]@{ Name = 'credential suffix'; Value = 'other/service/password'; Confidence = 'Medium'; Reason = 'path_with_secret_field_suffix' },
        [pscustomobject]@{ Name = 'hierarchical path'; Value = 'other/service/env/region/value'; Confidence = 'Medium'; Reason = 'hierarchical_reference_shape' },
        [pscustomobject]@{ Name = 'ordinary password'; Value = 'correct-horse-battery-staple'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'URL'; Value = 'https://example.com/a/b/c'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'JSON'; Value = '{"password":"not-a-reference"}'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'connection string'; Value = 'Server=db;Password=example'; Confidence = $null; Reason = $null }
    )

    foreach ($case in $cases) {
        $actual = Test-SecretValueShape -Value $case.Value -KnownReferences $references -KnownNormalizedReferences $normalizedReferences

        if ($null -eq $case.Confidence) {
            if ($null -ne $actual) {
                throw "Self-test '$($case.Name)' unexpectedly classified as $($actual.Confidence)/$($actual.Reason)."
            }
            continue
        }

        if ($null -eq $actual) {
            throw "Self-test '$($case.Name)' unexpectedly produced no finding."
        }
        if ($actual.Confidence -ne $case.Confidence -or $actual.Reason -ne $case.Reason) {
            throw "Self-test '$($case.Name)' returned $($actual.Confidence)/$($actual.Reason), expected $($case.Confidence)/$($case.Reason)."
        }
    }

    Write-Host "Self-test passed: $($cases.Count) classifier cases."
}

if ($SelfTest) {
    Invoke-ClassifierSelfTest
    exit 0
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or later is required."
    }

    $resolvedConjur = Resolve-ConjurExecutable -Path $ConjurPath

    $versionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--version') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($versionResult.ExitCode -ne 0) {
        throw "Unable to read the Conjur CLI version."
    }

    $versionMatch = [System.Text.RegularExpressions.Regex]::Match($versionResult.Stdout, '(?<![0-9])([0-9]+)\.([0-9]+)\.([0-9]+)')
    if (-not $versionMatch.Success) {
        throw "Unable to parse the Conjur CLI version."
    }

    $majorVersion = [int]$versionMatch.Groups[1].Value
    if ($majorVersion -ne 9 -and -not $AllowUnsupportedVersion) {
        throw "This audit is qualified for Conjur CLI 9.x. Re-run with -AllowUnsupportedVersion only after reviewing CLI output compatibility."
    }

    $sessionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'whoami', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($sessionResult.ExitCode -ne 0) {
        throw "Conjur session verification failed. Authenticate with the approved vendor flow before auditing."
    }
    $null = ConvertFrom-ConjurJson -Json $sessionResult.Stdout -Context 'conjur whoami'

    $listResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'list', '--kind', 'variable', '--limit=-1', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($listResult.ExitCode -ne 0) {
        throw "Conjur variable enumeration failed."
    }

    $listed = ConvertFrom-ConjurJson -Json $listResult.Stdout -Context 'conjur list'
    if ($null -eq $listed) {
        $resources = @()
    }
    else {
        $resources = @($listed)
    }

    $records = New-Object 'System.Collections.Generic.List[object]'
    $resourceIds = New-OrdinalStringSet
    $knownReferences = New-OrdinalStringSet
    $knownNormalizedReferences = New-OrdinalStringSet

    foreach ($resource in $resources) {
        if ($null -eq $resource) {
            throw "Conjur list returned a null variable entry; refusing a partial audit."
        }

        $idProperty = $resource.PSObject.Properties['id']
        if ($null -eq $idProperty -or [string]::IsNullOrWhiteSpace([string]$idProperty.Value)) {
            throw "Conjur list returned a variable entry without an id; refusing a partial audit."
        }

        $resourceId = [string]$idProperty.Value
        if (-not $resourceIds.Add($resourceId)) {
            continue
        }

        $variableId = ConvertFrom-ResourceIdToVariableId -ResourceId $resourceId
        [void]$knownReferences.Add($resourceId)
        [void]$knownReferences.Add($variableId)
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $resourceId))
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $variableId))

        $records.Add([pscustomobject][ordered]@{
            ResourceId = $resourceId
            VariableId = $variableId
        })
    }

    $orderedRecords = @($records | Sort-Object -Property VariableId, ResourceId)
    $findings = New-Object 'System.Collections.Generic.List[object]'
    $failures = New-Object 'System.Collections.Generic.List[object]'
    $inspected = 0

    for ($index = 0; $index -lt $orderedRecords.Count; $index++) {
        $record = $orderedRecords[$index]
        $position = $index + 1
        $percent = 100
        if ($orderedRecords.Count -gt 0) {
            $percent = [int](($position / [double]$orderedRecords.Count) * 100)
        }
        Write-Progress -Activity 'Auditing Conjur variable values' -Status "$position of $($orderedRecords.Count)" -PercentComplete $percent

        $getResult = $null
        $secretObject = $null
        $secretValue = $null

        try {
            $getResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'variable', 'get', '--id', $record.VariableId, '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
            if ($getResult.ExitCode -ne 0) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'retrieval_failed'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            try {
                $secretObject = ConvertFrom-ConjurJson -Json $getResult.Stdout -Context 'conjur variable get'
            }
            catch {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'invalid_secret_json'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $valueProperty = $secretObject.PSObject.Properties['value']
            if ($null -eq $valueProperty) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'missing_value_field'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $secretValue = [string]$valueProperty.Value
            $inspected++

            $classification = Test-SecretValueShape -Value $secretValue -KnownReferences $knownReferences -KnownNormalizedReferences $knownNormalizedReferences
            if ($null -ne $classification -and (Test-MeetsMinimumConfidence -Confidence $classification.Confidence -Minimum $MinimumConfidence)) {
                $findings.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    Confidence = $classification.Confidence
                    Reason     = $classification.Reason
                })
            }
        }
        finally {
            $secretValue = $null
            $secretObject = $null
            $getResult = $null
        }
    }

    Write-Progress -Activity 'Auditing Conjur variable values' -Completed

    $report = [pscustomobject][ordered]@{
        SchemaVersion     = 1
        GeneratedAtUtc    = [DateTime]::UtcNow.ToString('o')
        ConjurVersion     = $versionMatch.Value
        TotalVariables    = $orderedRecords.Count
        InspectedValues   = $inspected
        SuspiciousValues  = $findings.Count
        RetrievalFailures = $failures.Count
        MinimumConfidence = $MinimumConfidence
        Findings          = @($findings)
        Failures          = @($failures)
    }

    Write-Host ""
    Write-Host "Conjur secret-value audit complete."
    Write-Host "Variables enumerated : $($report.TotalVariables)"
    Write-Host "Values inspected     : $($report.InspectedValues)"
    Write-Host "Suspicious values    : $($report.SuspiciousValues)"
    Write-Host "Retrieval failures   : $($report.RetrievalFailures)"
    Write-Host "Secret values were not printed or written to the report."

    if ($findings.Count -gt 0) {
        Write-Host ""
        Write-Host "Suspicious values (value omitted):"
        $findings |
            Sort-Object -Property Confidence, VariableId |
            Format-Table -Property VariableId, Confidence, Reason -AutoSize |
            Out-Host
    }

    if ($failures.Count -gt 0) {
        Write-Host ""
        Write-Host "Variables that could not be fully inspected:"
        $failures |
            Sort-Object -Property VariableId |
            Format-Table -Property VariableId, ErrorCode, ExitCode -AutoSize |
            Out-Host
    }

    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
        $parent = Split-Path -Parent $fullOutputPath
        if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw "OutputPath parent directory does not exist."
        }
        if ((Test-Path -LiteralPath $fullOutputPath) -and -not $Force) {
            throw "OutputPath already exists. Use -Force to replace the redacted report."
        }

        $json = $report | ConvertTo-Json -Depth 8
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($fullOutputPath, $json, $utf8NoBom)
        Write-Host "Redacted report      : $fullOutputPath"
    }

    if ($failures.Count -gt 0) {
        exit 3
    }
    if ($findings.Count -gt 0) {
        exit 2
    }
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
)) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'path_with_secret_field_suffix'
            }
        }

        $separatorCount = ([System.Text.RegularExpressions.Regex]::Matches($candidate, '[./\\]')).Count
        if ($separatorCount -ge 3) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'hierarchical_reference_shape'
            }
        }
    }

    return $null
}

function Test-MeetsMinimumConfidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Confidence,
        [Parameter(Mandatory = $true)]
        [string]$Minimum
    )

    if ($Minimum -eq 'High') {
        return $Confidence -eq 'High'
    }
    return $Confidence -eq 'High' -or $Confidence -eq 'Medium'
}

function Invoke-ClassifierSelfTest {
    $references = New-OrdinalStringSet
    $normalizedReferences = New-OrdinalStringSet

    foreach ($reference in @(
        'prod/service/password',
        'RH/value/value/value/password',
        'acme:variable:prod/service/token'
    )) {
        [void]$references.Add($reference)
        [void]$normalizedReferences.Add((Normalize-ReferenceShape -Value $reference))
    }

    $cases = @(
        [pscustomobject]@{ Name = 'exact known path'; Value = 'prod/service/password'; Confidence = 'High'; Reason = 'exact_known_variable_reference' },
        [pscustomobject]@{ Name = 'normalized dot path'; Value = 'RH.value.value.value/password'; Confidence = 'High'; Reason = 'normalized_known_variable_reference' },
        [pscustomobject]@{ Name = 'reference URI'; Value = 'conjur://prod/service/password'; Confidence = 'High'; Reason = 'secret_reference_uri' },
        [pscustomobject]@{ Name = 'dot notation shape'; Value = 'other.team.database/password'; Confidence = 'Medium'; Reason = 'dot_notation_reference_shape' },
        [pscustomobject]@{ Name = 'credential suffix'; Value = 'other/service/password'; Confidence = 'Medium'; Reason = 'path_with_secret_field_suffix' },
        [pscustomobject]@{ Name = 'hierarchical path'; Value = 'other/service/env/region/value'; Confidence = 'Medium'; Reason = 'hierarchical_reference_shape' },
        [pscustomobject]@{ Name = 'ordinary password'; Value = 'correct-horse-battery-staple'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'URL'; Value = 'https://example.com/a/b/c'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'JSON'; Value = '{"password":"not-a-reference"}'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'connection string'; Value = 'Server=db;Password=example'; Confidence = $null; Reason = $null }
    )

    foreach ($case in $cases) {
        $actual = Test-SecretValueShape -Value $case.Value -KnownReferences $references -KnownNormalizedReferences $normalizedReferences

        if ($null -eq $case.Confidence) {
            if ($null -ne $actual) {
                throw "Self-test '$($case.Name)' unexpectedly classified as $($actual.Confidence)/$($actual.Reason)."
            }
            continue
        }

        if ($null -eq $actual) {
            throw "Self-test '$($case.Name)' unexpectedly produced no finding."
        }
        if ($actual.Confidence -ne $case.Confidence -or $actual.Reason -ne $case.Reason) {
            throw "Self-test '$($case.Name)' returned $($actual.Confidence)/$($actual.Reason), expected $($case.Confidence)/$($case.Reason)."
        }
    }

    Write-Host "Self-test passed: $($cases.Count) classifier cases."
}

if ($SelfTest) {
    Invoke-ClassifierSelfTest
    exit 0
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or later is required."
    }

    $resolvedConjur = Resolve-ConjurExecutable -Path $ConjurPath

    $versionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--version') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($versionResult.ExitCode -ne 0) {
        throw "Unable to read the Conjur CLI version."
    }

    $versionMatch = [System.Text.RegularExpressions.Regex]::Match($versionResult.Stdout, '(?<![0-9])([0-9]+)\.([0-9]+)\.([0-9]+)')
    if (-not $versionMatch.Success) {
        throw "Unable to parse the Conjur CLI version."
    }

    $majorVersion = [int]$versionMatch.Groups[1].Value
    if ($majorVersion -ne 9 -and -not $AllowUnsupportedVersion) {
        throw "This audit is qualified for Conjur CLI 9.x. Re-run with -AllowUnsupportedVersion only after reviewing CLI output compatibility."
    }

    $sessionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'whoami', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($sessionResult.ExitCode -ne 0) {
        throw "Conjur session verification failed. Authenticate with the approved vendor flow before auditing."
    }
    $null = ConvertFrom-ConjurJson -Json $sessionResult.Stdout -Context 'conjur whoami'

    $listResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'list', '--kind', 'variable', '--limit=-1', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($listResult.ExitCode -ne 0) {
        throw "Conjur variable enumeration failed."
    }

    $listed = ConvertFrom-ConjurJson -Json $listResult.Stdout -Context 'conjur list'
    if ($null -eq $listed) {
        $resources = @()
    }
    else {
        $resources = @($listed)
    }

    $records = New-Object 'System.Collections.Generic.List[object]'
    $resourceIds = New-OrdinalStringSet
    $knownReferences = New-OrdinalStringSet
    $knownNormalizedReferences = New-OrdinalStringSet

    foreach ($resource in $resources) {
        if ($null -eq $resource) {
            throw "Conjur list returned a null variable entry; refusing a partial audit."
        }

        $idProperty = $resource.PSObject.Properties['id']
        if ($null -eq $idProperty -or [string]::IsNullOrWhiteSpace([string]$idProperty.Value)) {
            throw "Conjur list returned a variable entry without an id; refusing a partial audit."
        }

        $resourceId = [string]$idProperty.Value
        if (-not $resourceIds.Add($resourceId)) {
            continue
        }

        $variableId = ConvertFrom-ResourceIdToVariableId -ResourceId $resourceId
        [void]$knownReferences.Add($resourceId)
        [void]$knownReferences.Add($variableId)
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $resourceId))
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $variableId))

        $records.Add([pscustomobject][ordered]@{
            ResourceId = $resourceId
            VariableId = $variableId
        })
    }

    $orderedRecords = @($records | Sort-Object -Property VariableId, ResourceId)
    $findings = New-Object 'System.Collections.Generic.List[object]'
    $failures = New-Object 'System.Collections.Generic.List[object]'
    $inspected = 0

    for ($index = 0; $index -lt $orderedRecords.Count; $index++) {
        $record = $orderedRecords[$index]
        $position = $index + 1
        $percent = 100
        if ($orderedRecords.Count -gt 0) {
            $percent = [int](($position / [double]$orderedRecords.Count) * 100)
        }
        Write-Progress -Activity 'Auditing Conjur variable values' -Status "$position of $($orderedRecords.Count)" -PercentComplete $percent

        $getResult = $null
        $secretObject = $null
        $secretValue = $null

        try {
            $getResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'variable', 'get', '--id', $record.VariableId, '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
            if ($getResult.ExitCode -ne 0) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'retrieval_failed'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            try {
                $secretObject = ConvertFrom-ConjurJson -Json $getResult.Stdout -Context 'conjur variable get'
            }
            catch {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'invalid_secret_json'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $valueProperty = $secretObject.PSObject.Properties['value']
            if ($null -eq $valueProperty) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'missing_value_field'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $secretValue = [string]$valueProperty.Value
            $inspected++

            $classification = Test-SecretValueShape -Value $secretValue -KnownReferences $knownReferences -KnownNormalizedReferences $knownNormalizedReferences
            if ($null -ne $classification -and (Test-MeetsMinimumConfidence -Confidence $classification.Confidence -Minimum $MinimumConfidence)) {
                $findings.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    Confidence = $classification.Confidence
                    Reason     = $classification.Reason
                })
            }
        }
        finally {
            $secretValue = $null
            $secretObject = $null
            $getResult = $null
        }
    }

    Write-Progress -Activity 'Auditing Conjur variable values' -Completed

    $report = [pscustomobject][ordered]@{
        SchemaVersion     = 1
        GeneratedAtUtc    = [DateTime]::UtcNow.ToString('o')
        ConjurVersion     = $versionMatch.Value
        TotalVariables    = $orderedRecords.Count
        InspectedValues   = $inspected
        SuspiciousValues  = $findings.Count
        RetrievalFailures = $failures.Count
        MinimumConfidence = $MinimumConfidence
        Findings          = @($findings)
        Failures          = @($failures)
    }

    Write-Host ""
    Write-Host "Conjur secret-value audit complete."
    Write-Host "Variables enumerated : $($report.TotalVariables)"
    Write-Host "Values inspected     : $($report.InspectedValues)"
    Write-Host "Suspicious values    : $($report.SuspiciousValues)"
    Write-Host "Retrieval failures   : $($report.RetrievalFailures)"
    Write-Host "Secret values were not printed or written to the report."

    if ($findings.Count -gt 0) {
        Write-Host ""
        Write-Host "Suspicious values (value omitted):"
        $findings |
            Sort-Object -Property Confidence, VariableId |
            Format-Table -Property VariableId, Confidence, Reason -AutoSize |
            Out-Host
    }

    if ($failures.Count -gt 0) {
        Write-Host ""
        Write-Host "Variables that could not be fully inspected:"
        $failures |
            Sort-Object -Property VariableId |
            Format-Table -Property VariableId, ErrorCode, ExitCode -AutoSize |
            Out-Host
    }

    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
        $parent = Split-Path -Parent $fullOutputPath
        if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw "OutputPath parent directory does not exist."
        }
        if ((Test-Path -LiteralPath $fullOutputPath) -and -not $Force) {
            throw "OutputPath already exists. Use -Force to replace the redacted report."
        }

        $json = $report | ConvertTo-Json -Depth 8
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($fullOutputPath, $json, $utf8NoBom)
        Write-Host "Redacted report      : $fullOutputPath"
    }

    if ($failures.Count -gt 0) {
        exit 3
    }
    if ($findings.Count -gt 0) {
        exit 2
    }
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
 -or
        $candidate -match '^v?\d+(?:\.\d+){2,}(?:[-+][A-Za-z0-9.-]+)?
    if ($candidate -match $pathPattern) {
        if ($candidate -match '(?:^|[\\/])(password|passwd|pwd|username|user|token|api[-_]?key|secret|client[-_]?secret|private[-_]?key|access[-_]?key|credential|credentials)$') {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'path_with_secret_field_suffix'
            }
        }

        $separatorCount = ([System.Text.RegularExpressions.Regex]::Matches($candidate, '[./\\]')).Count
        if ($separatorCount -ge 3) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'hierarchical_reference_shape'
            }
        }
    }

    return $null
}

function Test-MeetsMinimumConfidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Confidence,
        [Parameter(Mandatory = $true)]
        [string]$Minimum
    )

    if ($Minimum -eq 'High') {
        return $Confidence -eq 'High'
    }
    return $Confidence -eq 'High' -or $Confidence -eq 'Medium'
}

function Invoke-ClassifierSelfTest {
    $references = New-OrdinalStringSet
    $normalizedReferences = New-OrdinalStringSet

    foreach ($reference in @(
        'prod/service/password',
        'RH/value/value/value/password',
        'acme:variable:prod/service/token'
    )) {
        [void]$references.Add($reference)
        [void]$normalizedReferences.Add((Normalize-ReferenceShape -Value $reference))
    }

    $cases = @(
        [pscustomobject]@{ Name = 'exact known path'; Value = 'prod/service/password'; Confidence = 'High'; Reason = 'exact_known_variable_reference' },
        [pscustomobject]@{ Name = 'normalized dot path'; Value = 'RH.value.value.value/password'; Confidence = 'High'; Reason = 'normalized_known_variable_reference' },
        [pscustomobject]@{ Name = 'reference URI'; Value = 'conjur://prod/service/password'; Confidence = 'High'; Reason = 'secret_reference_uri' },
        [pscustomobject]@{ Name = 'dot notation shape'; Value = 'other.team.database/password'; Confidence = 'Medium'; Reason = 'dot_notation_reference_shape' },
        [pscustomobject]@{ Name = 'credential suffix'; Value = 'other/service/password'; Confidence = 'Medium'; Reason = 'path_with_secret_field_suffix' },
        [pscustomobject]@{ Name = 'hierarchical path'; Value = 'other/service/env/region/value'; Confidence = 'Medium'; Reason = 'hierarchical_reference_shape' },
        [pscustomobject]@{ Name = 'ordinary password'; Value = 'correct-horse-battery-staple'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'URL'; Value = 'https://example.com/a/b/c'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'JSON'; Value = '{"password":"not-a-reference"}'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'connection string'; Value = 'Server=db;Password=example'; Confidence = $null; Reason = $null }
    )

    foreach ($case in $cases) {
        $actual = Test-SecretValueShape -Value $case.Value -KnownReferences $references -KnownNormalizedReferences $normalizedReferences

        if ($null -eq $case.Confidence) {
            if ($null -ne $actual) {
                throw "Self-test '$($case.Name)' unexpectedly classified as $($actual.Confidence)/$($actual.Reason)."
            }
            continue
        }

        if ($null -eq $actual) {
            throw "Self-test '$($case.Name)' unexpectedly produced no finding."
        }
        if ($actual.Confidence -ne $case.Confidence -or $actual.Reason -ne $case.Reason) {
            throw "Self-test '$($case.Name)' returned $($actual.Confidence)/$($actual.Reason), expected $($case.Confidence)/$($case.Reason)."
        }
    }

    Write-Host "Self-test passed: $($cases.Count) classifier cases."
}

if ($SelfTest) {
    Invoke-ClassifierSelfTest
    exit 0
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or later is required."
    }

    $resolvedConjur = Resolve-ConjurExecutable -Path $ConjurPath

    $versionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--version') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($versionResult.ExitCode -ne 0) {
        throw "Unable to read the Conjur CLI version."
    }

    $versionMatch = [System.Text.RegularExpressions.Regex]::Match($versionResult.Stdout, '(?<![0-9])([0-9]+)\.([0-9]+)\.([0-9]+)')
    if (-not $versionMatch.Success) {
        throw "Unable to parse the Conjur CLI version."
    }

    $majorVersion = [int]$versionMatch.Groups[1].Value
    if ($majorVersion -ne 9 -and -not $AllowUnsupportedVersion) {
        throw "This audit is qualified for Conjur CLI 9.x. Re-run with -AllowUnsupportedVersion only after reviewing CLI output compatibility."
    }

    $sessionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'whoami', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($sessionResult.ExitCode -ne 0) {
        throw "Conjur session verification failed. Authenticate with the approved vendor flow before auditing."
    }
    $null = ConvertFrom-ConjurJson -Json $sessionResult.Stdout -Context 'conjur whoami'

    $listResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'list', '--kind', 'variable', '--limit=-1', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($listResult.ExitCode -ne 0) {
        throw "Conjur variable enumeration failed."
    }

    $listed = ConvertFrom-ConjurJson -Json $listResult.Stdout -Context 'conjur list'
    if ($null -eq $listed) {
        $resources = @()
    }
    else {
        $resources = @($listed)
    }

    $records = New-Object 'System.Collections.Generic.List[object]'
    $resourceIds = New-OrdinalStringSet
    $knownReferences = New-OrdinalStringSet
    $knownNormalizedReferences = New-OrdinalStringSet

    foreach ($resource in $resources) {
        if ($null -eq $resource) {
            throw "Conjur list returned a null variable entry; refusing a partial audit."
        }

        $idProperty = $resource.PSObject.Properties['id']
        if ($null -eq $idProperty -or [string]::IsNullOrWhiteSpace([string]$idProperty.Value)) {
            throw "Conjur list returned a variable entry without an id; refusing a partial audit."
        }

        $resourceId = [string]$idProperty.Value
        if (-not $resourceIds.Add($resourceId)) {
            continue
        }

        $variableId = ConvertFrom-ResourceIdToVariableId -ResourceId $resourceId
        [void]$knownReferences.Add($resourceId)
        [void]$knownReferences.Add($variableId)
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $resourceId))
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $variableId))

        $records.Add([pscustomobject][ordered]@{
            ResourceId = $resourceId
            VariableId = $variableId
        })
    }

    $orderedRecords = @($records | Sort-Object -Property VariableId, ResourceId)
    $findings = New-Object 'System.Collections.Generic.List[object]'
    $failures = New-Object 'System.Collections.Generic.List[object]'
    $inspected = 0

    for ($index = 0; $index -lt $orderedRecords.Count; $index++) {
        $record = $orderedRecords[$index]
        $position = $index + 1
        $percent = 100
        if ($orderedRecords.Count -gt 0) {
            $percent = [int](($position / [double]$orderedRecords.Count) * 100)
        }
        Write-Progress -Activity 'Auditing Conjur variable values' -Status "$position of $($orderedRecords.Count)" -PercentComplete $percent

        $getResult = $null
        $secretObject = $null
        $secretValue = $null

        try {
            $getResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'variable', 'get', '--id', $record.VariableId, '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
            if ($getResult.ExitCode -ne 0) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'retrieval_failed'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            try {
                $secretObject = ConvertFrom-ConjurJson -Json $getResult.Stdout -Context 'conjur variable get'
            }
            catch {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'invalid_secret_json'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $valueProperty = $secretObject.PSObject.Properties['value']
            if ($null -eq $valueProperty) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'missing_value_field'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $secretValue = [string]$valueProperty.Value
            $inspected++

            $classification = Test-SecretValueShape -Value $secretValue -KnownReferences $knownReferences -KnownNormalizedReferences $knownNormalizedReferences
            if ($null -ne $classification -and (Test-MeetsMinimumConfidence -Confidence $classification.Confidence -Minimum $MinimumConfidence)) {
                $findings.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    Confidence = $classification.Confidence
                    Reason     = $classification.Reason
                })
            }
        }
        finally {
            $secretValue = $null
            $secretObject = $null
            $getResult = $null
        }
    }

    Write-Progress -Activity 'Auditing Conjur variable values' -Completed

    $report = [pscustomobject][ordered]@{
        SchemaVersion     = 1
        GeneratedAtUtc    = [DateTime]::UtcNow.ToString('o')
        ConjurVersion     = $versionMatch.Value
        TotalVariables    = $orderedRecords.Count
        InspectedValues   = $inspected
        SuspiciousValues  = $findings.Count
        RetrievalFailures = $failures.Count
        MinimumConfidence = $MinimumConfidence
        Findings          = @($findings)
        Failures          = @($failures)
    }

    Write-Host ""
    Write-Host "Conjur secret-value audit complete."
    Write-Host "Variables enumerated : $($report.TotalVariables)"
    Write-Host "Values inspected     : $($report.InspectedValues)"
    Write-Host "Suspicious values    : $($report.SuspiciousValues)"
    Write-Host "Retrieval failures   : $($report.RetrievalFailures)"
    Write-Host "Secret values were not printed or written to the report."

    if ($findings.Count -gt 0) {
        Write-Host ""
        Write-Host "Suspicious values (value omitted):"
        $findings |
            Sort-Object -Property Confidence, VariableId |
            Format-Table -Property VariableId, Confidence, Reason -AutoSize |
            Out-Host
    }

    if ($failures.Count -gt 0) {
        Write-Host ""
        Write-Host "Variables that could not be fully inspected:"
        $failures |
            Sort-Object -Property VariableId |
            Format-Table -Property VariableId, ErrorCode, ExitCode -AutoSize |
            Out-Host
    }

    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
        $parent = Split-Path -Parent $fullOutputPath
        if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw "OutputPath parent directory does not exist."
        }
        if ((Test-Path -LiteralPath $fullOutputPath) -and -not $Force) {
            throw "OutputPath already exists. Use -Force to replace the redacted report."
        }

        $json = $report | ConvertTo-Json -Depth 8
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($fullOutputPath, $json, $utf8NoBom)
        Write-Host "Redacted report      : $fullOutputPath"
    }

    if ($failures.Count -gt 0) {
        exit 3
    }
    if ($findings.Count -gt 0) {
        exit 2
    }
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
 -or
        $candidate -match '^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}
    if ($candidate -match $pathPattern) {
        if ($candidate -match '(?:^|[\\/])(password|passwd|pwd|username|user|token|api[-_]?key|secret|client[-_]?secret|private[-_]?key|access[-_]?key|credential|credentials)$') {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'path_with_secret_field_suffix'
            }
        }

        $separatorCount = ([System.Text.RegularExpressions.Regex]::Matches($candidate, '[./\\]')).Count
        if ($separatorCount -ge 3) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'hierarchical_reference_shape'
            }
        }
    }

    return $null
}

function Test-MeetsMinimumConfidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Confidence,
        [Parameter(Mandatory = $true)]
        [string]$Minimum
    )

    if ($Minimum -eq 'High') {
        return $Confidence -eq 'High'
    }
    return $Confidence -eq 'High' -or $Confidence -eq 'Medium'
}

function Invoke-ClassifierSelfTest {
    $references = New-OrdinalStringSet
    $normalizedReferences = New-OrdinalStringSet

    foreach ($reference in @(
        'prod/service/password',
        'RH/value/value/value/password',
        'acme:variable:prod/service/token'
    )) {
        [void]$references.Add($reference)
        [void]$normalizedReferences.Add((Normalize-ReferenceShape -Value $reference))
    }

    $cases = @(
        [pscustomobject]@{ Name = 'exact known path'; Value = 'prod/service/password'; Confidence = 'High'; Reason = 'exact_known_variable_reference' },
        [pscustomobject]@{ Name = 'normalized dot path'; Value = 'RH.value.value.value/password'; Confidence = 'High'; Reason = 'normalized_known_variable_reference' },
        [pscustomobject]@{ Name = 'reference URI'; Value = 'conjur://prod/service/password'; Confidence = 'High'; Reason = 'secret_reference_uri' },
        [pscustomobject]@{ Name = 'dot notation shape'; Value = 'other.team.database/password'; Confidence = 'Medium'; Reason = 'dot_notation_reference_shape' },
        [pscustomobject]@{ Name = 'credential suffix'; Value = 'other/service/password'; Confidence = 'Medium'; Reason = 'path_with_secret_field_suffix' },
        [pscustomobject]@{ Name = 'hierarchical path'; Value = 'other/service/env/region/value'; Confidence = 'Medium'; Reason = 'hierarchical_reference_shape' },
        [pscustomobject]@{ Name = 'ordinary password'; Value = 'correct-horse-battery-staple'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'URL'; Value = 'https://example.com/a/b/c'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'JSON'; Value = '{"password":"not-a-reference"}'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'connection string'; Value = 'Server=db;Password=example'; Confidence = $null; Reason = $null }
    )

    foreach ($case in $cases) {
        $actual = Test-SecretValueShape -Value $case.Value -KnownReferences $references -KnownNormalizedReferences $normalizedReferences

        if ($null -eq $case.Confidence) {
            if ($null -ne $actual) {
                throw "Self-test '$($case.Name)' unexpectedly classified as $($actual.Confidence)/$($actual.Reason)."
            }
            continue
        }

        if ($null -eq $actual) {
            throw "Self-test '$($case.Name)' unexpectedly produced no finding."
        }
        if ($actual.Confidence -ne $case.Confidence -or $actual.Reason -ne $case.Reason) {
            throw "Self-test '$($case.Name)' returned $($actual.Confidence)/$($actual.Reason), expected $($case.Confidence)/$($case.Reason)."
        }
    }

    Write-Host "Self-test passed: $($cases.Count) classifier cases."
}

if ($SelfTest) {
    Invoke-ClassifierSelfTest
    exit 0
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or later is required."
    }

    $resolvedConjur = Resolve-ConjurExecutable -Path $ConjurPath

    $versionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--version') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($versionResult.ExitCode -ne 0) {
        throw "Unable to read the Conjur CLI version."
    }

    $versionMatch = [System.Text.RegularExpressions.Regex]::Match($versionResult.Stdout, '(?<![0-9])([0-9]+)\.([0-9]+)\.([0-9]+)')
    if (-not $versionMatch.Success) {
        throw "Unable to parse the Conjur CLI version."
    }

    $majorVersion = [int]$versionMatch.Groups[1].Value
    if ($majorVersion -ne 9 -and -not $AllowUnsupportedVersion) {
        throw "This audit is qualified for Conjur CLI 9.x. Re-run with -AllowUnsupportedVersion only after reviewing CLI output compatibility."
    }

    $sessionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'whoami', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($sessionResult.ExitCode -ne 0) {
        throw "Conjur session verification failed. Authenticate with the approved vendor flow before auditing."
    }
    $null = ConvertFrom-ConjurJson -Json $sessionResult.Stdout -Context 'conjur whoami'

    $listResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'list', '--kind', 'variable', '--limit=-1', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($listResult.ExitCode -ne 0) {
        throw "Conjur variable enumeration failed."
    }

    $listed = ConvertFrom-ConjurJson -Json $listResult.Stdout -Context 'conjur list'
    if ($null -eq $listed) {
        $resources = @()
    }
    else {
        $resources = @($listed)
    }

    $records = New-Object 'System.Collections.Generic.List[object]'
    $resourceIds = New-OrdinalStringSet
    $knownReferences = New-OrdinalStringSet
    $knownNormalizedReferences = New-OrdinalStringSet

    foreach ($resource in $resources) {
        if ($null -eq $resource) {
            throw "Conjur list returned a null variable entry; refusing a partial audit."
        }

        $idProperty = $resource.PSObject.Properties['id']
        if ($null -eq $idProperty -or [string]::IsNullOrWhiteSpace([string]$idProperty.Value)) {
            throw "Conjur list returned a variable entry without an id; refusing a partial audit."
        }

        $resourceId = [string]$idProperty.Value
        if (-not $resourceIds.Add($resourceId)) {
            continue
        }

        $variableId = ConvertFrom-ResourceIdToVariableId -ResourceId $resourceId
        [void]$knownReferences.Add($resourceId)
        [void]$knownReferences.Add($variableId)
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $resourceId))
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $variableId))

        $records.Add([pscustomobject][ordered]@{
            ResourceId = $resourceId
            VariableId = $variableId
        })
    }

    $orderedRecords = @($records | Sort-Object -Property VariableId, ResourceId)
    $findings = New-Object 'System.Collections.Generic.List[object]'
    $failures = New-Object 'System.Collections.Generic.List[object]'
    $inspected = 0

    for ($index = 0; $index -lt $orderedRecords.Count; $index++) {
        $record = $orderedRecords[$index]
        $position = $index + 1
        $percent = 100
        if ($orderedRecords.Count -gt 0) {
            $percent = [int](($position / [double]$orderedRecords.Count) * 100)
        }
        Write-Progress -Activity 'Auditing Conjur variable values' -Status "$position of $($orderedRecords.Count)" -PercentComplete $percent

        $getResult = $null
        $secretObject = $null
        $secretValue = $null

        try {
            $getResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'variable', 'get', '--id', $record.VariableId, '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
            if ($getResult.ExitCode -ne 0) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'retrieval_failed'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            try {
                $secretObject = ConvertFrom-ConjurJson -Json $getResult.Stdout -Context 'conjur variable get'
            }
            catch {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'invalid_secret_json'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $valueProperty = $secretObject.PSObject.Properties['value']
            if ($null -eq $valueProperty) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'missing_value_field'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $secretValue = [string]$valueProperty.Value
            $inspected++

            $classification = Test-SecretValueShape -Value $secretValue -KnownReferences $knownReferences -KnownNormalizedReferences $knownNormalizedReferences
            if ($null -ne $classification -and (Test-MeetsMinimumConfidence -Confidence $classification.Confidence -Minimum $MinimumConfidence)) {
                $findings.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    Confidence = $classification.Confidence
                    Reason     = $classification.Reason
                })
            }
        }
        finally {
            $secretValue = $null
            $secretObject = $null
            $getResult = $null
        }
    }

    Write-Progress -Activity 'Auditing Conjur variable values' -Completed

    $report = [pscustomobject][ordered]@{
        SchemaVersion     = 1
        GeneratedAtUtc    = [DateTime]::UtcNow.ToString('o')
        ConjurVersion     = $versionMatch.Value
        TotalVariables    = $orderedRecords.Count
        InspectedValues   = $inspected
        SuspiciousValues  = $findings.Count
        RetrievalFailures = $failures.Count
        MinimumConfidence = $MinimumConfidence
        Findings          = @($findings)
        Failures          = @($failures)
    }

    Write-Host ""
    Write-Host "Conjur secret-value audit complete."
    Write-Host "Variables enumerated : $($report.TotalVariables)"
    Write-Host "Values inspected     : $($report.InspectedValues)"
    Write-Host "Suspicious values    : $($report.SuspiciousValues)"
    Write-Host "Retrieval failures   : $($report.RetrievalFailures)"
    Write-Host "Secret values were not printed or written to the report."

    if ($findings.Count -gt 0) {
        Write-Host ""
        Write-Host "Suspicious values (value omitted):"
        $findings |
            Sort-Object -Property Confidence, VariableId |
            Format-Table -Property VariableId, Confidence, Reason -AutoSize |
            Out-Host
    }

    if ($failures.Count -gt 0) {
        Write-Host ""
        Write-Host "Variables that could not be fully inspected:"
        $failures |
            Sort-Object -Property VariableId |
            Format-Table -Property VariableId, ErrorCode, ExitCode -AutoSize |
            Out-Host
    }

    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
        $parent = Split-Path -Parent $fullOutputPath
        if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw "OutputPath parent directory does not exist."
        }
        if ((Test-Path -LiteralPath $fullOutputPath) -and -not $Force) {
            throw "OutputPath already exists. Use -Force to replace the redacted report."
        }

        $json = $report | ConvertTo-Json -Depth 8
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($fullOutputPath, $json, $utf8NoBom)
        Write-Host "Redacted report      : $fullOutputPath"
    }

    if ($failures.Count -gt 0) {
        exit 3
    }
    if ($findings.Count -gt 0) {
        exit 2
    }
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}

    ) {
        return $null
    }

    $secretFieldSuffix = '(password|passwd|pwd|username|user|token|api[-_]?key|secret|client[-_]?secret|private[-_]?key|access[-_]?key|credential|credentials)'
    $dotReferencePattern = '^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,}(?:[\\/][A-Za-z0-9_.@-]+(?:[\\/][A-Za-z0-9_.@-]+)*)?
    if ($candidate -match $pathPattern) {
        if ($candidate -match '(?:^|[\\/])(password|passwd|pwd|username|user|token|api[-_]?key|secret|client[-_]?secret|private[-_]?key|access[-_]?key|credential|credentials)$') {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'path_with_secret_field_suffix'
            }
        }

        $separatorCount = ([System.Text.RegularExpressions.Regex]::Matches($candidate, '[./\\]')).Count
        if ($separatorCount -ge 3) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'hierarchical_reference_shape'
            }
        }
    }

    return $null
}

function Test-MeetsMinimumConfidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Confidence,
        [Parameter(Mandatory = $true)]
        [string]$Minimum
    )

    if ($Minimum -eq 'High') {
        return $Confidence -eq 'High'
    }
    return $Confidence -eq 'High' -or $Confidence -eq 'Medium'
}

function Invoke-ClassifierSelfTest {
    $references = New-OrdinalStringSet
    $normalizedReferences = New-OrdinalStringSet

    foreach ($reference in @(
        'prod/service/password',
        'RH/value/value/value/password',
        'acme:variable:prod/service/token'
    )) {
        [void]$references.Add($reference)
        [void]$normalizedReferences.Add((Normalize-ReferenceShape -Value $reference))
    }

    $cases = @(
        [pscustomobject]@{ Name = 'exact known path'; Value = 'prod/service/password'; Confidence = 'High'; Reason = 'exact_known_variable_reference' },
        [pscustomobject]@{ Name = 'normalized dot path'; Value = 'RH.value.value.value/password'; Confidence = 'High'; Reason = 'normalized_known_variable_reference' },
        [pscustomobject]@{ Name = 'reference URI'; Value = 'conjur://prod/service/password'; Confidence = 'High'; Reason = 'secret_reference_uri' },
        [pscustomobject]@{ Name = 'dot notation shape'; Value = 'other.team.database/password'; Confidence = 'Medium'; Reason = 'dot_notation_reference_shape' },
        [pscustomobject]@{ Name = 'credential suffix'; Value = 'other/service/password'; Confidence = 'Medium'; Reason = 'path_with_secret_field_suffix' },
        [pscustomobject]@{ Name = 'hierarchical path'; Value = 'other/service/env/region/value'; Confidence = 'Medium'; Reason = 'hierarchical_reference_shape' },
        [pscustomobject]@{ Name = 'ordinary password'; Value = 'correct-horse-battery-staple'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'URL'; Value = 'https://example.com/a/b/c'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'JSON'; Value = '{"password":"not-a-reference"}'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'connection string'; Value = 'Server=db;Password=example'; Confidence = $null; Reason = $null }
    )

    foreach ($case in $cases) {
        $actual = Test-SecretValueShape -Value $case.Value -KnownReferences $references -KnownNormalizedReferences $normalizedReferences

        if ($null -eq $case.Confidence) {
            if ($null -ne $actual) {
                throw "Self-test '$($case.Name)' unexpectedly classified as $($actual.Confidence)/$($actual.Reason)."
            }
            continue
        }

        if ($null -eq $actual) {
            throw "Self-test '$($case.Name)' unexpectedly produced no finding."
        }
        if ($actual.Confidence -ne $case.Confidence -or $actual.Reason -ne $case.Reason) {
            throw "Self-test '$($case.Name)' returned $($actual.Confidence)/$($actual.Reason), expected $($case.Confidence)/$($case.Reason)."
        }
    }

    Write-Host "Self-test passed: $($cases.Count) classifier cases."
}

if ($SelfTest) {
    Invoke-ClassifierSelfTest
    exit 0
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or later is required."
    }

    $resolvedConjur = Resolve-ConjurExecutable -Path $ConjurPath

    $versionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--version') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($versionResult.ExitCode -ne 0) {
        throw "Unable to read the Conjur CLI version."
    }

    $versionMatch = [System.Text.RegularExpressions.Regex]::Match($versionResult.Stdout, '(?<![0-9])([0-9]+)\.([0-9]+)\.([0-9]+)')
    if (-not $versionMatch.Success) {
        throw "Unable to parse the Conjur CLI version."
    }

    $majorVersion = [int]$versionMatch.Groups[1].Value
    if ($majorVersion -ne 9 -and -not $AllowUnsupportedVersion) {
        throw "This audit is qualified for Conjur CLI 9.x. Re-run with -AllowUnsupportedVersion only after reviewing CLI output compatibility."
    }

    $sessionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'whoami', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($sessionResult.ExitCode -ne 0) {
        throw "Conjur session verification failed. Authenticate with the approved vendor flow before auditing."
    }
    $null = ConvertFrom-ConjurJson -Json $sessionResult.Stdout -Context 'conjur whoami'

    $listResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'list', '--kind', 'variable', '--limit=-1', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($listResult.ExitCode -ne 0) {
        throw "Conjur variable enumeration failed."
    }

    $listed = ConvertFrom-ConjurJson -Json $listResult.Stdout -Context 'conjur list'
    if ($null -eq $listed) {
        $resources = @()
    }
    else {
        $resources = @($listed)
    }

    $records = New-Object 'System.Collections.Generic.List[object]'
    $resourceIds = New-OrdinalStringSet
    $knownReferences = New-OrdinalStringSet
    $knownNormalizedReferences = New-OrdinalStringSet

    foreach ($resource in $resources) {
        if ($null -eq $resource) {
            throw "Conjur list returned a null variable entry; refusing a partial audit."
        }

        $idProperty = $resource.PSObject.Properties['id']
        if ($null -eq $idProperty -or [string]::IsNullOrWhiteSpace([string]$idProperty.Value)) {
            throw "Conjur list returned a variable entry without an id; refusing a partial audit."
        }

        $resourceId = [string]$idProperty.Value
        if (-not $resourceIds.Add($resourceId)) {
            continue
        }

        $variableId = ConvertFrom-ResourceIdToVariableId -ResourceId $resourceId
        [void]$knownReferences.Add($resourceId)
        [void]$knownReferences.Add($variableId)
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $resourceId))
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $variableId))

        $records.Add([pscustomobject][ordered]@{
            ResourceId = $resourceId
            VariableId = $variableId
        })
    }

    $orderedRecords = @($records | Sort-Object -Property VariableId, ResourceId)
    $findings = New-Object 'System.Collections.Generic.List[object]'
    $failures = New-Object 'System.Collections.Generic.List[object]'
    $inspected = 0

    for ($index = 0; $index -lt $orderedRecords.Count; $index++) {
        $record = $orderedRecords[$index]
        $position = $index + 1
        $percent = 100
        if ($orderedRecords.Count -gt 0) {
            $percent = [int](($position / [double]$orderedRecords.Count) * 100)
        }
        Write-Progress -Activity 'Auditing Conjur variable values' -Status "$position of $($orderedRecords.Count)" -PercentComplete $percent

        $getResult = $null
        $secretObject = $null
        $secretValue = $null

        try {
            $getResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'variable', 'get', '--id', $record.VariableId, '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
            if ($getResult.ExitCode -ne 0) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'retrieval_failed'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            try {
                $secretObject = ConvertFrom-ConjurJson -Json $getResult.Stdout -Context 'conjur variable get'
            }
            catch {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'invalid_secret_json'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $valueProperty = $secretObject.PSObject.Properties['value']
            if ($null -eq $valueProperty) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'missing_value_field'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $secretValue = [string]$valueProperty.Value
            $inspected++

            $classification = Test-SecretValueShape -Value $secretValue -KnownReferences $knownReferences -KnownNormalizedReferences $knownNormalizedReferences
            if ($null -ne $classification -and (Test-MeetsMinimumConfidence -Confidence $classification.Confidence -Minimum $MinimumConfidence)) {
                $findings.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    Confidence = $classification.Confidence
                    Reason     = $classification.Reason
                })
            }
        }
        finally {
            $secretValue = $null
            $secretObject = $null
            $getResult = $null
        }
    }

    Write-Progress -Activity 'Auditing Conjur variable values' -Completed

    $report = [pscustomobject][ordered]@{
        SchemaVersion     = 1
        GeneratedAtUtc    = [DateTime]::UtcNow.ToString('o')
        ConjurVersion     = $versionMatch.Value
        TotalVariables    = $orderedRecords.Count
        InspectedValues   = $inspected
        SuspiciousValues  = $findings.Count
        RetrievalFailures = $failures.Count
        MinimumConfidence = $MinimumConfidence
        Findings          = @($findings)
        Failures          = @($failures)
    }

    Write-Host ""
    Write-Host "Conjur secret-value audit complete."
    Write-Host "Variables enumerated : $($report.TotalVariables)"
    Write-Host "Values inspected     : $($report.InspectedValues)"
    Write-Host "Suspicious values    : $($report.SuspiciousValues)"
    Write-Host "Retrieval failures   : $($report.RetrievalFailures)"
    Write-Host "Secret values were not printed or written to the report."

    if ($findings.Count -gt 0) {
        Write-Host ""
        Write-Host "Suspicious values (value omitted):"
        $findings |
            Sort-Object -Property Confidence, VariableId |
            Format-Table -Property VariableId, Confidence, Reason -AutoSize |
            Out-Host
    }

    if ($failures.Count -gt 0) {
        Write-Host ""
        Write-Host "Variables that could not be fully inspected:"
        $failures |
            Sort-Object -Property VariableId |
            Format-Table -Property VariableId, ErrorCode, ExitCode -AutoSize |
            Out-Host
    }

    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
        $parent = Split-Path -Parent $fullOutputPath
        if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw "OutputPath parent directory does not exist."
        }
        if ((Test-Path -LiteralPath $fullOutputPath) -and -not $Force) {
            throw "OutputPath already exists. Use -Force to replace the redacted report."
        }

        $json = $report | ConvertTo-Json -Depth 8
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($fullOutputPath, $json, $utf8NoBom)
        Write-Host "Redacted report      : $fullOutputPath"
    }

    if ($failures.Count -gt 0) {
        exit 3
    }
    if ($findings.Count -gt 0) {
        exit 2
    }
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}

    if ($candidate -match $dotReferencePattern) {
        if (
            $candidate.Contains('/') -or
            $candidate.Contains('\') -or
            $candidate -match ("\." + $secretFieldSuffix + '
    if ($candidate -match $pathPattern) {
        if ($candidate -match '(?:^|[\\/])(password|passwd|pwd|username|user|token|api[-_]?key|secret|client[-_]?secret|private[-_]?key|access[-_]?key|credential|credentials)$') {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'path_with_secret_field_suffix'
            }
        }

        $separatorCount = ([System.Text.RegularExpressions.Regex]::Matches($candidate, '[./\\]')).Count
        if ($separatorCount -ge 3) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'hierarchical_reference_shape'
            }
        }
    }

    return $null
}

function Test-MeetsMinimumConfidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Confidence,
        [Parameter(Mandatory = $true)]
        [string]$Minimum
    )

    if ($Minimum -eq 'High') {
        return $Confidence -eq 'High'
    }
    return $Confidence -eq 'High' -or $Confidence -eq 'Medium'
}

function Invoke-ClassifierSelfTest {
    $references = New-OrdinalStringSet
    $normalizedReferences = New-OrdinalStringSet

    foreach ($reference in @(
        'prod/service/password',
        'RH/value/value/value/password',
        'acme:variable:prod/service/token'
    )) {
        [void]$references.Add($reference)
        [void]$normalizedReferences.Add((Normalize-ReferenceShape -Value $reference))
    }

    $cases = @(
        [pscustomobject]@{ Name = 'exact known path'; Value = 'prod/service/password'; Confidence = 'High'; Reason = 'exact_known_variable_reference' },
        [pscustomobject]@{ Name = 'normalized dot path'; Value = 'RH.value.value.value/password'; Confidence = 'High'; Reason = 'normalized_known_variable_reference' },
        [pscustomobject]@{ Name = 'reference URI'; Value = 'conjur://prod/service/password'; Confidence = 'High'; Reason = 'secret_reference_uri' },
        [pscustomobject]@{ Name = 'dot notation shape'; Value = 'other.team.database/password'; Confidence = 'Medium'; Reason = 'dot_notation_reference_shape' },
        [pscustomobject]@{ Name = 'credential suffix'; Value = 'other/service/password'; Confidence = 'Medium'; Reason = 'path_with_secret_field_suffix' },
        [pscustomobject]@{ Name = 'hierarchical path'; Value = 'other/service/env/region/value'; Confidence = 'Medium'; Reason = 'hierarchical_reference_shape' },
        [pscustomobject]@{ Name = 'ordinary password'; Value = 'correct-horse-battery-staple'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'URL'; Value = 'https://example.com/a/b/c'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'JSON'; Value = '{"password":"not-a-reference"}'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'connection string'; Value = 'Server=db;Password=example'; Confidence = $null; Reason = $null }
    )

    foreach ($case in $cases) {
        $actual = Test-SecretValueShape -Value $case.Value -KnownReferences $references -KnownNormalizedReferences $normalizedReferences

        if ($null -eq $case.Confidence) {
            if ($null -ne $actual) {
                throw "Self-test '$($case.Name)' unexpectedly classified as $($actual.Confidence)/$($actual.Reason)."
            }
            continue
        }

        if ($null -eq $actual) {
            throw "Self-test '$($case.Name)' unexpectedly produced no finding."
        }
        if ($actual.Confidence -ne $case.Confidence -or $actual.Reason -ne $case.Reason) {
            throw "Self-test '$($case.Name)' returned $($actual.Confidence)/$($actual.Reason), expected $($case.Confidence)/$($case.Reason)."
        }
    }

    Write-Host "Self-test passed: $($cases.Count) classifier cases."
}

if ($SelfTest) {
    Invoke-ClassifierSelfTest
    exit 0
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or later is required."
    }

    $resolvedConjur = Resolve-ConjurExecutable -Path $ConjurPath

    $versionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--version') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($versionResult.ExitCode -ne 0) {
        throw "Unable to read the Conjur CLI version."
    }

    $versionMatch = [System.Text.RegularExpressions.Regex]::Match($versionResult.Stdout, '(?<![0-9])([0-9]+)\.([0-9]+)\.([0-9]+)')
    if (-not $versionMatch.Success) {
        throw "Unable to parse the Conjur CLI version."
    }

    $majorVersion = [int]$versionMatch.Groups[1].Value
    if ($majorVersion -ne 9 -and -not $AllowUnsupportedVersion) {
        throw "This audit is qualified for Conjur CLI 9.x. Re-run with -AllowUnsupportedVersion only after reviewing CLI output compatibility."
    }

    $sessionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'whoami', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($sessionResult.ExitCode -ne 0) {
        throw "Conjur session verification failed. Authenticate with the approved vendor flow before auditing."
    }
    $null = ConvertFrom-ConjurJson -Json $sessionResult.Stdout -Context 'conjur whoami'

    $listResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'list', '--kind', 'variable', '--limit=-1', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($listResult.ExitCode -ne 0) {
        throw "Conjur variable enumeration failed."
    }

    $listed = ConvertFrom-ConjurJson -Json $listResult.Stdout -Context 'conjur list'
    if ($null -eq $listed) {
        $resources = @()
    }
    else {
        $resources = @($listed)
    }

    $records = New-Object 'System.Collections.Generic.List[object]'
    $resourceIds = New-OrdinalStringSet
    $knownReferences = New-OrdinalStringSet
    $knownNormalizedReferences = New-OrdinalStringSet

    foreach ($resource in $resources) {
        if ($null -eq $resource) {
            throw "Conjur list returned a null variable entry; refusing a partial audit."
        }

        $idProperty = $resource.PSObject.Properties['id']
        if ($null -eq $idProperty -or [string]::IsNullOrWhiteSpace([string]$idProperty.Value)) {
            throw "Conjur list returned a variable entry without an id; refusing a partial audit."
        }

        $resourceId = [string]$idProperty.Value
        if (-not $resourceIds.Add($resourceId)) {
            continue
        }

        $variableId = ConvertFrom-ResourceIdToVariableId -ResourceId $resourceId
        [void]$knownReferences.Add($resourceId)
        [void]$knownReferences.Add($variableId)
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $resourceId))
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $variableId))

        $records.Add([pscustomobject][ordered]@{
            ResourceId = $resourceId
            VariableId = $variableId
        })
    }

    $orderedRecords = @($records | Sort-Object -Property VariableId, ResourceId)
    $findings = New-Object 'System.Collections.Generic.List[object]'
    $failures = New-Object 'System.Collections.Generic.List[object]'
    $inspected = 0

    for ($index = 0; $index -lt $orderedRecords.Count; $index++) {
        $record = $orderedRecords[$index]
        $position = $index + 1
        $percent = 100
        if ($orderedRecords.Count -gt 0) {
            $percent = [int](($position / [double]$orderedRecords.Count) * 100)
        }
        Write-Progress -Activity 'Auditing Conjur variable values' -Status "$position of $($orderedRecords.Count)" -PercentComplete $percent

        $getResult = $null
        $secretObject = $null
        $secretValue = $null

        try {
            $getResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'variable', 'get', '--id', $record.VariableId, '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
            if ($getResult.ExitCode -ne 0) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'retrieval_failed'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            try {
                $secretObject = ConvertFrom-ConjurJson -Json $getResult.Stdout -Context 'conjur variable get'
            }
            catch {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'invalid_secret_json'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $valueProperty = $secretObject.PSObject.Properties['value']
            if ($null -eq $valueProperty) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'missing_value_field'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $secretValue = [string]$valueProperty.Value
            $inspected++

            $classification = Test-SecretValueShape -Value $secretValue -KnownReferences $knownReferences -KnownNormalizedReferences $knownNormalizedReferences
            if ($null -ne $classification -and (Test-MeetsMinimumConfidence -Confidence $classification.Confidence -Minimum $MinimumConfidence)) {
                $findings.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    Confidence = $classification.Confidence
                    Reason     = $classification.Reason
                })
            }
        }
        finally {
            $secretValue = $null
            $secretObject = $null
            $getResult = $null
        }
    }

    Write-Progress -Activity 'Auditing Conjur variable values' -Completed

    $report = [pscustomobject][ordered]@{
        SchemaVersion     = 1
        GeneratedAtUtc    = [DateTime]::UtcNow.ToString('o')
        ConjurVersion     = $versionMatch.Value
        TotalVariables    = $orderedRecords.Count
        InspectedValues   = $inspected
        SuspiciousValues  = $findings.Count
        RetrievalFailures = $failures.Count
        MinimumConfidence = $MinimumConfidence
        Findings          = @($findings)
        Failures          = @($failures)
    }

    Write-Host ""
    Write-Host "Conjur secret-value audit complete."
    Write-Host "Variables enumerated : $($report.TotalVariables)"
    Write-Host "Values inspected     : $($report.InspectedValues)"
    Write-Host "Suspicious values    : $($report.SuspiciousValues)"
    Write-Host "Retrieval failures   : $($report.RetrievalFailures)"
    Write-Host "Secret values were not printed or written to the report."

    if ($findings.Count -gt 0) {
        Write-Host ""
        Write-Host "Suspicious values (value omitted):"
        $findings |
            Sort-Object -Property Confidence, VariableId |
            Format-Table -Property VariableId, Confidence, Reason -AutoSize |
            Out-Host
    }

    if ($failures.Count -gt 0) {
        Write-Host ""
        Write-Host "Variables that could not be fully inspected:"
        $failures |
            Sort-Object -Property VariableId |
            Format-Table -Property VariableId, ErrorCode, ExitCode -AutoSize |
            Out-Host
    }

    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
        $parent = Split-Path -Parent $fullOutputPath
        if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw "OutputPath parent directory does not exist."
        }
        if ((Test-Path -LiteralPath $fullOutputPath) -and -not $Force) {
            throw "OutputPath already exists. Use -Force to replace the redacted report."
        }

        $json = $report | ConvertTo-Json -Depth 8
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($fullOutputPath, $json, $utf8NoBom)
        Write-Host "Redacted report      : $fullOutputPath"
    }

    if ($failures.Count -gt 0) {
        exit 3
    }
    if ($findings.Count -gt 0) {
        exit 2
    }
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
)
        ) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'dot_notation_reference_shape'
            }
        }
    }

    $pathPattern = '^[A-Za-z0-9_.@-]+(?:[\\/][A-Za-z0-9_.@-]+)+
    if ($candidate -match $pathPattern) {
        if ($candidate -match '(?:^|[\\/])(password|passwd|pwd|username|user|token|api[-_]?key|secret|client[-_]?secret|private[-_]?key|access[-_]?key|credential|credentials)$') {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'path_with_secret_field_suffix'
            }
        }

        $separatorCount = ([System.Text.RegularExpressions.Regex]::Matches($candidate, '[./\\]')).Count
        if ($separatorCount -ge 3) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'hierarchical_reference_shape'
            }
        }
    }

    return $null
}

function Test-MeetsMinimumConfidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Confidence,
        [Parameter(Mandatory = $true)]
        [string]$Minimum
    )

    if ($Minimum -eq 'High') {
        return $Confidence -eq 'High'
    }
    return $Confidence -eq 'High' -or $Confidence -eq 'Medium'
}

function Invoke-ClassifierSelfTest {
    $references = New-OrdinalStringSet
    $normalizedReferences = New-OrdinalStringSet

    foreach ($reference in @(
        'prod/service/password',
        'RH/value/value/value/password',
        'acme:variable:prod/service/token'
    )) {
        [void]$references.Add($reference)
        [void]$normalizedReferences.Add((Normalize-ReferenceShape -Value $reference))
    }

    $cases = @(
        [pscustomobject]@{ Name = 'exact known path'; Value = 'prod/service/password'; Confidence = 'High'; Reason = 'exact_known_variable_reference' },
        [pscustomobject]@{ Name = 'normalized dot path'; Value = 'RH.value.value.value/password'; Confidence = 'High'; Reason = 'normalized_known_variable_reference' },
        [pscustomobject]@{ Name = 'reference URI'; Value = 'conjur://prod/service/password'; Confidence = 'High'; Reason = 'secret_reference_uri' },
        [pscustomobject]@{ Name = 'dot notation shape'; Value = 'other.team.database/password'; Confidence = 'Medium'; Reason = 'dot_notation_reference_shape' },
        [pscustomobject]@{ Name = 'credential suffix'; Value = 'other/service/password'; Confidence = 'Medium'; Reason = 'path_with_secret_field_suffix' },
        [pscustomobject]@{ Name = 'hierarchical path'; Value = 'other/service/env/region/value'; Confidence = 'Medium'; Reason = 'hierarchical_reference_shape' },
        [pscustomobject]@{ Name = 'ordinary password'; Value = 'correct-horse-battery-staple'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'URL'; Value = 'https://example.com/a/b/c'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'JSON'; Value = '{"password":"not-a-reference"}'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'connection string'; Value = 'Server=db;Password=example'; Confidence = $null; Reason = $null }
    )

    foreach ($case in $cases) {
        $actual = Test-SecretValueShape -Value $case.Value -KnownReferences $references -KnownNormalizedReferences $normalizedReferences

        if ($null -eq $case.Confidence) {
            if ($null -ne $actual) {
                throw "Self-test '$($case.Name)' unexpectedly classified as $($actual.Confidence)/$($actual.Reason)."
            }
            continue
        }

        if ($null -eq $actual) {
            throw "Self-test '$($case.Name)' unexpectedly produced no finding."
        }
        if ($actual.Confidence -ne $case.Confidence -or $actual.Reason -ne $case.Reason) {
            throw "Self-test '$($case.Name)' returned $($actual.Confidence)/$($actual.Reason), expected $($case.Confidence)/$($case.Reason)."
        }
    }

    Write-Host "Self-test passed: $($cases.Count) classifier cases."
}

if ($SelfTest) {
    Invoke-ClassifierSelfTest
    exit 0
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or later is required."
    }

    $resolvedConjur = Resolve-ConjurExecutable -Path $ConjurPath

    $versionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--version') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($versionResult.ExitCode -ne 0) {
        throw "Unable to read the Conjur CLI version."
    }

    $versionMatch = [System.Text.RegularExpressions.Regex]::Match($versionResult.Stdout, '(?<![0-9])([0-9]+)\.([0-9]+)\.([0-9]+)')
    if (-not $versionMatch.Success) {
        throw "Unable to parse the Conjur CLI version."
    }

    $majorVersion = [int]$versionMatch.Groups[1].Value
    if ($majorVersion -ne 9 -and -not $AllowUnsupportedVersion) {
        throw "This audit is qualified for Conjur CLI 9.x. Re-run with -AllowUnsupportedVersion only after reviewing CLI output compatibility."
    }

    $sessionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'whoami', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($sessionResult.ExitCode -ne 0) {
        throw "Conjur session verification failed. Authenticate with the approved vendor flow before auditing."
    }
    $null = ConvertFrom-ConjurJson -Json $sessionResult.Stdout -Context 'conjur whoami'

    $listResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'list', '--kind', 'variable', '--limit=-1', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($listResult.ExitCode -ne 0) {
        throw "Conjur variable enumeration failed."
    }

    $listed = ConvertFrom-ConjurJson -Json $listResult.Stdout -Context 'conjur list'
    if ($null -eq $listed) {
        $resources = @()
    }
    else {
        $resources = @($listed)
    }

    $records = New-Object 'System.Collections.Generic.List[object]'
    $resourceIds = New-OrdinalStringSet
    $knownReferences = New-OrdinalStringSet
    $knownNormalizedReferences = New-OrdinalStringSet

    foreach ($resource in $resources) {
        if ($null -eq $resource) {
            throw "Conjur list returned a null variable entry; refusing a partial audit."
        }

        $idProperty = $resource.PSObject.Properties['id']
        if ($null -eq $idProperty -or [string]::IsNullOrWhiteSpace([string]$idProperty.Value)) {
            throw "Conjur list returned a variable entry without an id; refusing a partial audit."
        }

        $resourceId = [string]$idProperty.Value
        if (-not $resourceIds.Add($resourceId)) {
            continue
        }

        $variableId = ConvertFrom-ResourceIdToVariableId -ResourceId $resourceId
        [void]$knownReferences.Add($resourceId)
        [void]$knownReferences.Add($variableId)
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $resourceId))
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $variableId))

        $records.Add([pscustomobject][ordered]@{
            ResourceId = $resourceId
            VariableId = $variableId
        })
    }

    $orderedRecords = @($records | Sort-Object -Property VariableId, ResourceId)
    $findings = New-Object 'System.Collections.Generic.List[object]'
    $failures = New-Object 'System.Collections.Generic.List[object]'
    $inspected = 0

    for ($index = 0; $index -lt $orderedRecords.Count; $index++) {
        $record = $orderedRecords[$index]
        $position = $index + 1
        $percent = 100
        if ($orderedRecords.Count -gt 0) {
            $percent = [int](($position / [double]$orderedRecords.Count) * 100)
        }
        Write-Progress -Activity 'Auditing Conjur variable values' -Status "$position of $($orderedRecords.Count)" -PercentComplete $percent

        $getResult = $null
        $secretObject = $null
        $secretValue = $null

        try {
            $getResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'variable', 'get', '--id', $record.VariableId, '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
            if ($getResult.ExitCode -ne 0) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'retrieval_failed'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            try {
                $secretObject = ConvertFrom-ConjurJson -Json $getResult.Stdout -Context 'conjur variable get'
            }
            catch {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'invalid_secret_json'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $valueProperty = $secretObject.PSObject.Properties['value']
            if ($null -eq $valueProperty) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'missing_value_field'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $secretValue = [string]$valueProperty.Value
            $inspected++

            $classification = Test-SecretValueShape -Value $secretValue -KnownReferences $knownReferences -KnownNormalizedReferences $knownNormalizedReferences
            if ($null -ne $classification -and (Test-MeetsMinimumConfidence -Confidence $classification.Confidence -Minimum $MinimumConfidence)) {
                $findings.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    Confidence = $classification.Confidence
                    Reason     = $classification.Reason
                })
            }
        }
        finally {
            $secretValue = $null
            $secretObject = $null
            $getResult = $null
        }
    }

    Write-Progress -Activity 'Auditing Conjur variable values' -Completed

    $report = [pscustomobject][ordered]@{
        SchemaVersion     = 1
        GeneratedAtUtc    = [DateTime]::UtcNow.ToString('o')
        ConjurVersion     = $versionMatch.Value
        TotalVariables    = $orderedRecords.Count
        InspectedValues   = $inspected
        SuspiciousValues  = $findings.Count
        RetrievalFailures = $failures.Count
        MinimumConfidence = $MinimumConfidence
        Findings          = @($findings)
        Failures          = @($failures)
    }

    Write-Host ""
    Write-Host "Conjur secret-value audit complete."
    Write-Host "Variables enumerated : $($report.TotalVariables)"
    Write-Host "Values inspected     : $($report.InspectedValues)"
    Write-Host "Suspicious values    : $($report.SuspiciousValues)"
    Write-Host "Retrieval failures   : $($report.RetrievalFailures)"
    Write-Host "Secret values were not printed or written to the report."

    if ($findings.Count -gt 0) {
        Write-Host ""
        Write-Host "Suspicious values (value omitted):"
        $findings |
            Sort-Object -Property Confidence, VariableId |
            Format-Table -Property VariableId, Confidence, Reason -AutoSize |
            Out-Host
    }

    if ($failures.Count -gt 0) {
        Write-Host ""
        Write-Host "Variables that could not be fully inspected:"
        $failures |
            Sort-Object -Property VariableId |
            Format-Table -Property VariableId, ErrorCode, ExitCode -AutoSize |
            Out-Host
    }

    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
        $parent = Split-Path -Parent $fullOutputPath
        if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw "OutputPath parent directory does not exist."
        }
        if ((Test-Path -LiteralPath $fullOutputPath) -and -not $Force) {
            throw "OutputPath already exists. Use -Force to replace the redacted report."
        }

        $json = $report | ConvertTo-Json -Depth 8
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($fullOutputPath, $json, $utf8NoBom)
        Write-Host "Redacted report      : $fullOutputPath"
    }

    if ($failures.Count -gt 0) {
        exit 3
    }
    if ($findings.Count -gt 0) {
        exit 2
    }
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}

    if ($candidate -match $pathPattern) {
        if ($candidate -match '(?:^|[\\/])(password|passwd|pwd|username|user|token|api[-_]?key|secret|client[-_]?secret|private[-_]?key|access[-_]?key|credential|credentials)$') {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'path_with_secret_field_suffix'
            }
        }

        $separatorCount = ([System.Text.RegularExpressions.Regex]::Matches($candidate, '[./\\]')).Count
        if ($separatorCount -ge 3) {
            return [pscustomobject][ordered]@{
                Confidence = 'Medium'
                Reason     = 'hierarchical_reference_shape'
            }
        }
    }

    return $null
}

function Test-MeetsMinimumConfidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Confidence,
        [Parameter(Mandatory = $true)]
        [string]$Minimum
    )

    if ($Minimum -eq 'High') {
        return $Confidence -eq 'High'
    }
    return $Confidence -eq 'High' -or $Confidence -eq 'Medium'
}

function Invoke-ClassifierSelfTest {
    $references = New-OrdinalStringSet
    $normalizedReferences = New-OrdinalStringSet

    foreach ($reference in @(
        'prod/service/password',
        'RH/value/value/value/password',
        'acme:variable:prod/service/token'
    )) {
        [void]$references.Add($reference)
        [void]$normalizedReferences.Add((Normalize-ReferenceShape -Value $reference))
    }

    $cases = @(
        [pscustomobject]@{ Name = 'exact known path'; Value = 'prod/service/password'; Confidence = 'High'; Reason = 'exact_known_variable_reference' },
        [pscustomobject]@{ Name = 'normalized dot path'; Value = 'RH.value.value.value/password'; Confidence = 'High'; Reason = 'normalized_known_variable_reference' },
        [pscustomobject]@{ Name = 'reference URI'; Value = 'conjur://prod/service/password'; Confidence = 'High'; Reason = 'secret_reference_uri' },
        [pscustomobject]@{ Name = 'dot notation shape'; Value = 'other.team.database/password'; Confidence = 'Medium'; Reason = 'dot_notation_reference_shape' },
        [pscustomobject]@{ Name = 'credential suffix'; Value = 'other/service/password'; Confidence = 'Medium'; Reason = 'path_with_secret_field_suffix' },
        [pscustomobject]@{ Name = 'hierarchical path'; Value = 'other/service/env/region/value'; Confidence = 'Medium'; Reason = 'hierarchical_reference_shape' },
        [pscustomobject]@{ Name = 'ordinary password'; Value = 'correct-horse-battery-staple'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'URL'; Value = 'https://example.com/a/b/c'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'JSON'; Value = '{"password":"not-a-reference"}'; Confidence = $null; Reason = $null },
        [pscustomobject]@{ Name = 'connection string'; Value = 'Server=db;Password=example'; Confidence = $null; Reason = $null }
    )

    foreach ($case in $cases) {
        $actual = Test-SecretValueShape -Value $case.Value -KnownReferences $references -KnownNormalizedReferences $normalizedReferences

        if ($null -eq $case.Confidence) {
            if ($null -ne $actual) {
                throw "Self-test '$($case.Name)' unexpectedly classified as $($actual.Confidence)/$($actual.Reason)."
            }
            continue
        }

        if ($null -eq $actual) {
            throw "Self-test '$($case.Name)' unexpectedly produced no finding."
        }
        if ($actual.Confidence -ne $case.Confidence -or $actual.Reason -ne $case.Reason) {
            throw "Self-test '$($case.Name)' returned $($actual.Confidence)/$($actual.Reason), expected $($case.Confidence)/$($case.Reason)."
        }
    }

    Write-Host "Self-test passed: $($cases.Count) classifier cases."
}

if ($SelfTest) {
    Invoke-ClassifierSelfTest
    exit 0
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or later is required."
    }

    $resolvedConjur = Resolve-ConjurExecutable -Path $ConjurPath

    $versionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--version') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($versionResult.ExitCode -ne 0) {
        throw "Unable to read the Conjur CLI version."
    }

    $versionMatch = [System.Text.RegularExpressions.Regex]::Match($versionResult.Stdout, '(?<![0-9])([0-9]+)\.([0-9]+)\.([0-9]+)')
    if (-not $versionMatch.Success) {
        throw "Unable to parse the Conjur CLI version."
    }

    $majorVersion = [int]$versionMatch.Groups[1].Value
    if ($majorVersion -ne 9 -and -not $AllowUnsupportedVersion) {
        throw "This audit is qualified for Conjur CLI 9.x. Re-run with -AllowUnsupportedVersion only after reviewing CLI output compatibility."
    }

    $sessionResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'whoami', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($sessionResult.ExitCode -ne 0) {
        throw "Conjur session verification failed. Authenticate with the approved vendor flow before auditing."
    }
    $null = ConvertFrom-ConjurJson -Json $sessionResult.Stdout -Context 'conjur whoami'

    $listResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'list', '--kind', 'variable', '--limit=-1', '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
    if ($listResult.ExitCode -ne 0) {
        throw "Conjur variable enumeration failed."
    }

    $listed = ConvertFrom-ConjurJson -Json $listResult.Stdout -Context 'conjur list'
    if ($null -eq $listed) {
        $resources = @()
    }
    else {
        $resources = @($listed)
    }

    $records = New-Object 'System.Collections.Generic.List[object]'
    $resourceIds = New-OrdinalStringSet
    $knownReferences = New-OrdinalStringSet
    $knownNormalizedReferences = New-OrdinalStringSet

    foreach ($resource in $resources) {
        if ($null -eq $resource) {
            throw "Conjur list returned a null variable entry; refusing a partial audit."
        }

        $idProperty = $resource.PSObject.Properties['id']
        if ($null -eq $idProperty -or [string]::IsNullOrWhiteSpace([string]$idProperty.Value)) {
            throw "Conjur list returned a variable entry without an id; refusing a partial audit."
        }

        $resourceId = [string]$idProperty.Value
        if (-not $resourceIds.Add($resourceId)) {
            continue
        }

        $variableId = ConvertFrom-ResourceIdToVariableId -ResourceId $resourceId
        [void]$knownReferences.Add($resourceId)
        [void]$knownReferences.Add($variableId)
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $resourceId))
        [void]$knownNormalizedReferences.Add((Normalize-ReferenceShape -Value $variableId))

        $records.Add([pscustomobject][ordered]@{
            ResourceId = $resourceId
            VariableId = $variableId
        })
    }

    $orderedRecords = @($records | Sort-Object -Property VariableId, ResourceId)
    $findings = New-Object 'System.Collections.Generic.List[object]'
    $failures = New-Object 'System.Collections.Generic.List[object]'
    $inspected = 0

    for ($index = 0; $index -lt $orderedRecords.Count; $index++) {
        $record = $orderedRecords[$index]
        $position = $index + 1
        $percent = 100
        if ($orderedRecords.Count -gt 0) {
            $percent = [int](($position / [double]$orderedRecords.Count) * 100)
        }
        Write-Progress -Activity 'Auditing Conjur variable values' -Status "$position of $($orderedRecords.Count)" -PercentComplete $percent

        $getResult = $null
        $secretObject = $null
        $secretValue = $null

        try {
            $getResult = Invoke-ConjurProcess -Executable $resolvedConjur -Arguments @('--timeout', $HttpTimeout, 'variable', 'get', '--id', $record.VariableId, '--output', 'json') -TimeoutSeconds $ProcessTimeoutSeconds
            if ($getResult.ExitCode -ne 0) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'retrieval_failed'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            try {
                $secretObject = ConvertFrom-ConjurJson -Json $getResult.Stdout -Context 'conjur variable get'
            }
            catch {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'invalid_secret_json'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $valueProperty = $secretObject.PSObject.Properties['value']
            if ($null -eq $valueProperty) {
                $failures.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    ErrorCode  = 'missing_value_field'
                    ExitCode   = $getResult.ExitCode
                })
                continue
            }

            $secretValue = [string]$valueProperty.Value
            $inspected++

            $classification = Test-SecretValueShape -Value $secretValue -KnownReferences $knownReferences -KnownNormalizedReferences $knownNormalizedReferences
            if ($null -ne $classification -and (Test-MeetsMinimumConfidence -Confidence $classification.Confidence -Minimum $MinimumConfidence)) {
                $findings.Add([pscustomobject][ordered]@{
                    VariableId = $record.VariableId
                    ResourceId = $record.ResourceId
                    Confidence = $classification.Confidence
                    Reason     = $classification.Reason
                })
            }
        }
        finally {
            $secretValue = $null
            $secretObject = $null
            $getResult = $null
        }
    }

    Write-Progress -Activity 'Auditing Conjur variable values' -Completed

    $report = [pscustomobject][ordered]@{
        SchemaVersion     = 1
        GeneratedAtUtc    = [DateTime]::UtcNow.ToString('o')
        ConjurVersion     = $versionMatch.Value
        TotalVariables    = $orderedRecords.Count
        InspectedValues   = $inspected
        SuspiciousValues  = $findings.Count
        RetrievalFailures = $failures.Count
        MinimumConfidence = $MinimumConfidence
        Findings          = @($findings)
        Failures          = @($failures)
    }

    Write-Host ""
    Write-Host "Conjur secret-value audit complete."
    Write-Host "Variables enumerated : $($report.TotalVariables)"
    Write-Host "Values inspected     : $($report.InspectedValues)"
    Write-Host "Suspicious values    : $($report.SuspiciousValues)"
    Write-Host "Retrieval failures   : $($report.RetrievalFailures)"
    Write-Host "Secret values were not printed or written to the report."

    if ($findings.Count -gt 0) {
        Write-Host ""
        Write-Host "Suspicious values (value omitted):"
        $findings |
            Sort-Object -Property Confidence, VariableId |
            Format-Table -Property VariableId, Confidence, Reason -AutoSize |
            Out-Host
    }

    if ($failures.Count -gt 0) {
        Write-Host ""
        Write-Host "Variables that could not be fully inspected:"
        $failures |
            Sort-Object -Property VariableId |
            Format-Table -Property VariableId, ErrorCode, ExitCode -AutoSize |
            Out-Host
    }

    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
        $parent = Split-Path -Parent $fullOutputPath
        if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw "OutputPath parent directory does not exist."
        }
        if ((Test-Path -LiteralPath $fullOutputPath) -and -not $Force) {
            throw "OutputPath already exists. Use -Force to replace the redacted report."
        }

        $json = $report | ConvertTo-Json -Depth 8
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($fullOutputPath, $json, $utf8NoBom)
        Write-Host "Redacted report      : $fullOutputPath"
    }

    if ($failures.Count -gt 0) {
        exit 3
    }
    if ($findings.Count -gt 0) {
        exit 2
    }
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
