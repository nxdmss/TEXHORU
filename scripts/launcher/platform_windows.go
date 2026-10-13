package main
import("syscall";"unsafe")
func configureConsole(){
 syscall.NewLazyDLL("kernel32.dll").NewProc("SetConsoleOutputCP").Call(65001)
 title,_:=syscall.UTF16PtrFromString("TEXHORU");syscall.NewLazyDLL("kernel32.dll").NewProc("SetConsoleTitleW").Call(uintptr(unsafe.Pointer(title)))
}
func showError(message string){
 text,_:=syscall.UTF16PtrFromString(message);title,_:=syscall.UTF16PtrFromString("TEXHORU — запуск")
 syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0,uintptr(unsafe.Pointer(text)),uintptr(unsafe.Pointer(title)),0x10)
}
