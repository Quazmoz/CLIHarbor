package schemas

import _ "embed"

//go:embed pack.v1.schema.json
var packV1 []byte

// PackV1 returns an isolated copy of the embedded v1 pack schema.
func PackV1() []byte {
	return append([]byte(nil), packV1...)
}
