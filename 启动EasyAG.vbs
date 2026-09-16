Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = fso.BuildPath(appDir, "EasyAntigravity.exe")

On Error Resume Next
WshShell.CurrentDirectory = appDir
Err.Clear
WshShell.Environment("PROCESS")("NODE_NO_WARNINGS") = "1"
Err.Clear
On Error GoTo 0

If fso.FileExists(exe) Then
  ' 典型写法：四引号包路径，窗口样式 0 隐藏
  WshShell.Run """" & exe & """", 0, False
Else
  WshShell.Run "cmd /c node --no-warnings server.js", 0, False
End If
