package server

import (
 "encoding/json"
 "net/http"
 "testing"
 "github.com/Quazmoz/CLIHarbor/internal/audittrail"
)

type auditFixture struct{ entries []audittrail.Entry }
func (f auditFixture) List() []audittrail.Entry { return f.entries }

func TestAuditTrailAPIRequiresSessionAndDisclosesOnlyAllowedFields(t *testing.T) {
 s:=newTestServer(t, Config{Audit:auditFixture{entries:[]audittrail.Entry{{Sequence:1,RunID:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",Action:"approved",Undo:"not-available"}}}})
 unauth,err:=http.Get(s.BaseURL()+"/api/v1/audit")
 if err!=nil{t.Fatal(err)}
 unauth.Body.Close()
 if unauth.StatusCode!=http.StatusUnauthorized { t.Fatalf("unauthenticated status %d", unauth.StatusCode) }
 client:=sessionClient(t)
 bootstrap(t,client,s)
 res,err:=client.Get(s.BaseURL()+"/api/v1/audit")
 if err!=nil{t.Fatal(err)}
 defer res.Body.Close()
 if res.StatusCode!=http.StatusOK { t.Fatalf("authenticated status %d",res.StatusCode) }
 var payload struct {Entries []audittrail.Entry `json:"entries"`}
 if err:=json.NewDecoder(res.Body).Decode(&payload);err!=nil{t.Fatal(err)}
 if len(payload.Entries)!=1 || payload.Entries[0].Undo!="not-available"{t.Fatal("wrong audit result")}
}
