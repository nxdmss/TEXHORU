package main

import (
 "archive/zip"
 "crypto/sha256"
 "encoding/hex"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "net/http"
 "os"
 "os/exec"
 "path/filepath"
 "strconv"
 "strings"
 "time"
)
var mode = "start"
var client = &http.Client{Timeout: 5 * time.Minute}
func main() { configureConsole(); if err:=launch();err!=nil {fmt.Fprintln(os.Stderr,err);showError(err.Error());os.Exit(1)} }
func launch() error {
 exe,err:=os.Executable();if err!=nil{return err};root:=filepath.Dir(exe)
 if _,err=os.Stat(filepath.Join(root,"package.json"));err!=nil{return errors.New("Распакуй обновление в папку TEXHORU и запусти TEXHORU.exe из этой папки.")}
 node,err:=findNode(root);if err!=nil{return fmt.Errorf("Не удалось подготовить Node.js: %w",err)}
 script:="auto-start.mjs";if mode=="stop"{script="auto-stop.mjs"}
 cmd:=exec.Command(node,filepath.Join(root,"scripts",script));cmd.Dir=root
 cmd.Env=append(os.Environ(),"PATH="+filepath.Dir(node)+string(os.PathListSeparator)+os.Getenv("PATH"))
 cmd.Stdout=os.Stdout;cmd.Stderr=os.Stderr;cmd.Stdin=os.Stdin
 if err=cmd.Run();err!=nil{return fmt.Errorf("Запуск остановился. Подробности в %s",filepath.Join(root,".texhoru","startup.log"))};return nil
}
func nodeWorks(path string) bool {
 out,err:=exec.Command(path,"--version").Output();if err!=nil{return false}
 values:=strings.Split(strings.TrimPrefix(strings.TrimSpace(string(out)),"v"),".")
 major,err:=strconv.Atoi(values[0]);return err==nil&&major>=22
}
func findNode(root string)(string,error){
 if path,err:=exec.LookPath("node.exe");err==nil&&nodeWorks(path){return path,nil}
 state:=filepath.Join(root,".texhoru","runtime"); if base,err:=os.UserCacheDir();err==nil{state=filepath.Join(base,"TEXHORU","runtime")}
 paths,_:=filepath.Glob(filepath.Join(state,"node-v22*-win-x64","node.exe"))
 for _,path:=range paths{if nodeWorks(path){return path,nil}}
 fmt.Println("Первый запуск: скачиваю Node.js с официального сайта…")
 return downloadNode(state)
}
func fetch(url string)([]byte,error){
 response,err:=client.Get(url);if err!=nil{return nil,err};defer response.Body.Close()
 if response.StatusCode!=http.StatusOK{return nil,fmt.Errorf("Сайт загрузки ответил HTTP %d",response.StatusCode)}
 return io.ReadAll(io.LimitReader(response.Body,128<<20))
}
func downloadNode(state string)(string,error){
 data,err:=fetch("https://nodejs.org/dist/index.json");if err!=nil{return "",err}
 var releases []struct{Version string `json:"version"`;Files []string `json:"files"`}
 if err=json.Unmarshal(data,&releases);err!=nil{return "",err};version:=""
 for _,release:=range releases{if !strings.HasPrefix(release.Version,"v22."){continue};for _,file:=range release.Files{if file=="win-x64-zip"{version=release.Version;break}};if version!=""{break}}
 if version==""{return "",errors.New("Не найдена официальная Windows-версия Node.js 22")}
 filename:="node-"+version+"-win-x64.zip"
 sums,err:=fetch("https://nodejs.org/dist/"+version+"/SHASUMS256.txt");if err!=nil{return "",err};expected:=""
 for _,line:=range strings.Split(string(sums),"\n"){parts:=strings.Fields(line);if len(parts)==2&&parts[1]==filename{expected=parts[0];break}}
 if len(expected)!=64{return "",errors.New("Не найдена контрольная сумма Node.js")}
 bytes,err:=fetch("https://nodejs.org/dist/"+version+"/"+filename);if err!=nil{return "",err};sum:=sha256.Sum256(bytes)
 if hex.EncodeToString(sum[:])!=expected{return "",errors.New("Контрольная сумма Node.js не совпала; загрузка отменена")}
 if err=os.MkdirAll(state,0755);err!=nil{return "",err}
 archive,err:=os.CreateTemp(state,"node-download-*.zip");if err!=nil{return "",err};name:=archive.Name();defer os.Remove(name)
 if _,err=archive.Write(bytes);err!=nil{archive.Close();return "",err};archive.Close()
 stage,err:=os.MkdirTemp(state,"extract-");if err!=nil{return "",err};defer os.RemoveAll(stage)
 if err=extractZip(name,stage);err!=nil{return "",err};folder:="node-"+version+"-win-x64";dest:=filepath.Join(state,folder)
 if _,err=os.Stat(dest);err==nil{return "",errors.New("Неполная предыдущая установка Node.js. Пришли текст ошибки запуска.")}
 if err=os.Rename(filepath.Join(stage,folder),dest);err!=nil{return "",err}
 node:=filepath.Join(dest,"node.exe");if !nodeWorks(node){return "",errors.New("Загруженный Node.js не запускается")};return node,nil
}
func extractZip(path,target string)error{
 reader,err:=zip.OpenReader(path);if err!=nil{return err};defer reader.Close()
 for _,file:=range reader.File{
  dest:=filepath.Join(target,filepath.FromSlash(file.Name));rel,err:=filepath.Rel(target,dest)
  if err!=nil||rel==".."||strings.HasPrefix(rel,".."+string(os.PathSeparator))||filepath.IsAbs(rel){return errors.New("Небезопасный путь в архиве")}
  if file.Mode()&os.ModeSymlink!=0{return errors.New("Символические ссылки в архиве не поддерживаются")}
  if file.FileInfo().IsDir(){if err=os.MkdirAll(dest,0755);err!=nil{return err};continue}
  if err=os.MkdirAll(filepath.Dir(dest),0755);err!=nil{return err};input,err:=file.Open();if err!=nil{return err}
  output,err:=os.OpenFile(dest,os.O_CREATE|os.O_WRONLY|os.O_TRUNC,0644);if err!=nil{input.Close();return err}
  _,err=io.Copy(output,input);input.Close();output.Close();if err!=nil{return err}
 };return nil
}
