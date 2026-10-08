package audittrail

import (
 "os"
 "path/filepath"
 "strings"
 "testing"
 "github.com/Quazmoz/CLIHarbor/internal/runs"
)
func TestDurableAuditChainAndTampering(t *testing.T) {
 path:=filepath.Join(t.TempDir(),"audit","trail.jsonl")
 store,err:=Open(path);if err!=nil{t.Fatal(err)}
 event:=runs.AuditEvent{RunID:strings.Repeat("a",32),Action:"approved",PackID:"conjur",CommandID:"secret-delete",Risk:"destructive",TargetLabel:"Variable ID",Target:"apps/test/key",Effect:"Deletes variable",Scope:"single"}
 if err:=store.Append(event);err!=nil{t.Fatal(err)}
 if err:=store.Append(runs.AuditEvent{RunID:event.RunID,Action:"completed",Status:"exited"});err!=nil{t.Fatal(err)}
 if len(store.List())!=2 || store.List()[0].Status!="exited"{t.Fatal("out-of-order or absent audit")}
 if _,err:=Open(path);err==nil{t.Fatal("concurrent writer admitted")}
 if err:=store.Close();err!=nil{t.Fatal(err)}
 reopened,err:=Open(path);if err!=nil{t.Fatal(err)}
 if len(reopened.List())!=2{t.Fatal("lost audit on restart")}
 if err:=reopened.Close();err!=nil{t.Fatal(err)}
 raw,err:=os.ReadFile(path);if err!=nil{t.Fatal(err)}
 raw[35]^=1
 if err:=os.WriteFile(path,raw,0600);err!=nil{t.Fatal(err)}
 if _,err:=Open(path);err==nil{t.Fatal("tampered audit admitted")}
}
func TestAuditRejectsUnsafeDataAndPartialAppend(t *testing.T) {
 path:=filepath.Join(t.TempDir(),"trail")
 s,err:=Open(path);if err!=nil{t.Fatal(err)}
 t.Cleanup(func(){_ =s.Close()})
 if err:=s.Append(runs.AuditEvent{RunID:strings.Repeat("a",32),Action:"approved",Risk:"destructive",PackID:"p",CommandID:"c",TargetLabel:"target",Target:"bad\nvalue",Scope:"single"});err==nil{t.Fatal("multiline target admitted")}
 if len(s.List())!=0{t.Fatal("invalid event persisted")}
 if err:=s.Append(runs.AuditEvent{RunID:strings.Repeat("b",32),Action:"completed",Status:"exited"});err==nil {
  t.Fatal("orphan completion admitted")
 }
 approved:=runs.AuditEvent{RunID:strings.Repeat("a",32),Action:"approved",Risk:"change",PackID:"p",CommandID:"c",TargetLabel:"ID",Target:"target",Effect:"changes object",Scope:"single"}
 if err:=s.Append(approved);err!=nil{t.Fatal(err)}
 if err:=s.Append(approved);err==nil{t.Fatal("duplicate approval admitted")}
 if err:=s.Append(runs.AuditEvent{RunID:approved.RunID,Action:"completed",Status:"exited"});err!=nil{t.Fatal(err)}
 if err:=s.Append(runs.AuditEvent{RunID:approved.RunID,Action:"completed",Status:"exited"});err==nil{t.Fatal("duplicate completion admitted")}
}
