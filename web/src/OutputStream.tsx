import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

/** Inspect one retained stream without changing its evidence or execution. */
export function OutputStream({ name, text, live }: { name: 'stdout' | 'stderr'; text: string; live: boolean }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [wrap, setWrap] = useState(true);
  const [following, setFollowing] = useState(true);
  const [notice, setNotice] = useState<{ text: string; message: string } | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const search = query.toLocaleLowerCase();
  const matches = useMemo(() => {
    if (!search) return null;
    const lines: { number: number; text: string }[] = [];
    let count = 0;
    // ponytail: show the first 200 matching lines; add paging if larger searches need it.
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.toLocaleLowerCase().includes(search)) continue;
      count += 1;
      if (lines.length < 200) lines.push({ number: index + 1, text: line });
    }
    return { lines, count };
  }, [text, search]);

  useLayoutEffect(() => {
    if (preRef.current && live && following && !search) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [text, live, following, search, wrap]);

  useLayoutEffect(() => {
    if (search && preRef.current) preRef.current.scrollTop = 0;
  }, [search]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ text, message: `Copied ${name}.` });
    } catch {
      setNotice({ text, message: `Could not copy ${name}. Clipboard access is unavailable in this browser.` });
    }
  };

  return (
    <section className="output-stream" aria-labelledby={id + '-heading'}>
      <div className="output-heading">
        <h3 id={id + '-heading'}>{name}</h3>
        <button type="button" className="structured-copy-button" disabled={text === ''} onClick={() => void copy()}
          title="Copy the complete retained stream, including lines outside the search">
          Copy {name}
        </button>
      </div>
      <div className="output-stream-controls">
        <label htmlFor={id + '-search'}>Search {name}
          <input ref={searchRef} id={id + '-search'} type="search" value={query} maxLength={256}
            placeholder="Find text in lines" autoComplete="off" spellCheck={false}
            onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button type="button" className="secondary-button" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Wrap {name} lines</button>
        {live && <button type="button" className="secondary-button" aria-pressed={following && !search} disabled={Boolean(search)}
          onClick={() => setFollowing(!following)}>Follow {name}</button>}
        {query && <button type="button" className="link-button" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>Clear {name} search</button>}
      </div>
      <p className="output-stream-status" role="status">
        {matches ? `${matches.count} matching ${matches.count === 1 ? 'line' : 'lines'} in ${name}${matches.count > 200 ? ' · first 200 shown' : ''}. Clear search for complete output. Copy includes the complete retained stream.`
          : live ? following ? `Following live ${name}.` : `Live ${name} following paused.` : `Complete retained ${name}.`}
      </p>
      <pre ref={preRef} tabIndex={0} aria-label={name + ' output'} className={wrap ? undefined : 'output-stream-nowrap'}
        onScroll={(event) => {
          if (!live || search) return;
          const pre = event.currentTarget;
          setFollowing(pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24);
        }}>
        {matches ? matches.count === 0 ? `No ${name} lines match.` : matches.lines.map((line) => (
          <span className="output-search-line" key={line.number}>
            <span className="output-line-number" aria-hidden="true">{line.number}</span>
            <span>{line.text}{'\n'}</span>
          </span>
        )) : text || (live ? `No ${name} yet.` : `No ${name}.`)}
      </pre>
      {notice?.text === text && <p className="structured-copy-status" role="status">{notice.message}</p>}
    </section>
  );
}
