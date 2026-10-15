Option Explicit

Dim args, shell, command, exitCode
Set args = WScript.Arguments

If args.Count <> 5 Then WScript.Quit 2

Set shell = CreateObject("WScript.Shell")
command = Quote(args(0)) & " -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " & _
  Quote(args(1)) & " -NodePath " & Quote(args(2)) & _
  " -ScriptPath " & Quote(args(3)) & " -LogPath " & Quote(args(4))

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
