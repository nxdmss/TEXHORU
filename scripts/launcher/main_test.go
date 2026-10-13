package main
import("archive/zip";"os";"path/filepath";"testing")
func TestArchiveTraversalRejected(t *testing.T){
 dir:=t.TempDir();path:=filepath.Join(dir,"bad.zip");file,_:=os.Create(path);w:=zip.NewWriter(file);entry,_:=w.Create("../outside.txt");entry.Write([]byte("no"));w.Close();file.Close()
 if extractZip(path,filepath.Join(dir,"destination"))==nil{t.Fatal("path traversal accepted")}
 if _,err:=os.Stat(filepath.Join(dir,"outside.txt"));err==nil{t.Fatal("file escaped extraction")}
}
func TestOrdinaryArchive(t *testing.T){
 dir:=t.TempDir();path:=filepath.Join(dir,"good.zip");file,_:=os.Create(path);w:=zip.NewWriter(file);entry,_:=w.Create("node/runtime.txt");entry.Write([]byte("ok"));w.Close();file.Close()
 target:=filepath.Join(dir,"destination");if err:=extractZip(path,target);err!=nil{t.Fatal(err)}
 bytes,err:=os.ReadFile(filepath.Join(target,"node","runtime.txt"));if err!=nil||string(bytes)!="ok"{t.Fatal("extraction failed")}
}
