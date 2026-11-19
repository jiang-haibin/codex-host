Option Explicit

Dim fso, shell, baseDir, cliCmd, wmi, procs, ans, env, userProfile, oldNoProxy, logPath, cmdLine, exitCode, syncNode, historyHome

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
historyHome = fso.BuildPath(baseDir, "host-state\codex")

If WScript.Arguments.Count >= 2 Then
    If WScript.Arguments(0) = "--sync" Then
        syncNode = WScript.Arguments(1)
        WScript.Quit RunHistory(syncNode, "sync")
    End If
End If

If Not fso.FileExists(fso.BuildPath(historyHome, "state_5.sqlite")) Then
    MsgBox "Initialize history with node codex-history.mjs migrate in " & baseDir, vbCritical + vbSystemModal, "CodexHost Launcher"
    WScript.Quit 1
End If

cliCmd = ResolveCli("node.exe")
If cliCmd = "" Or Not fso.FileExists(cliCmd) Then
    MsgBox "Cannot find codexhost.cmd at:" & vbCrLf & cliCmd, vbCritical + vbSystemModal, "CodexHost Launcher"
    WScript.Quit 1
End If

' Check existing ChatGPT.exe / codexhost.exe processes
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT Name FROM Win32_Process WHERE Name = 'ChatGPT.exe' OR Name = 'codexhost.exe'")
If procs.Count > 0 Then
    ans = MsgBox("Existing Codex Desktop or CodexHost process is running." & vbCrLf & vbCrLf & "Force close existing instances and restart?", vbYesNo + vbQuestion + vbSystemModal, "CodexHost Launcher")
    If ans <> vbYes Then
        WScript.Quit 1
    End If
    shell.Run "taskkill /F /IM ChatGPT.exe", 0, True
    shell.Run "taskkill /F /IM codexhost.exe", 0, True
    WScript.Sleep 1000
End If

' Inject environment variables
Set env = shell.Environment("PROCESS")
userProfile = shell.ExpandEnvironmentStrings("%USERPROFILE%")
env("CODEX_HOME") = historyHome
env("CODEX_SQLITE_HOME") = historyHome
env("CODEXHOST_DATA_DIR") = fso.BuildPath(baseDir, "host-state\host")
env("CODEX_ELECTRON_USER_DATA_PATH") = fso.BuildPath(baseDir, "host-state\electron")
env("CODEXHOST_CONSOLE") = "0"
env("CODEXHOST_WORKBUDDY_COMMAND") = "D:\Workbuddy"
env("WORKBUDDY_CONFIG_DIR") = fso.BuildPath(baseDir, "host-state\host\workbuddy")
env("CODEXHOST_ANTIGRAVITY_COMMAND") = userProfile & "\.gemini\bin\agy.exe"

oldNoProxy = env("NO_PROXY")
If oldNoProxy <> "" Then
    env("NO_PROXY") = "workbuddy.cn,tencent.com,localhost,127.0.0.1," & oldNoProxy
Else
    env("NO_PROXY") = "workbuddy.cn,tencent.com,localhost,127.0.0.1"
End If
env("no_proxy") = env("NO_PROXY")

shell.CurrentDirectory = baseDir
exitCode = RunHistory("node.exe", "projects")
If exitCode <> 0 Then
    MsgBox "Could not migrate the Host project sidebar. See host-state\projects.log.", vbCritical + vbSystemModal, "CodexHost Launcher"
    WScript.Quit exitCode
End If
exitCode = RunHistory("node.exe", "sync")
logPath = fso.BuildPath(shell.ExpandEnvironmentStrings("%TEMP%"), "codexhost-silent-launch.log")

' Keep toast clicks from opening the official Codex instance
shell.Run "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & fso.BuildPath(baseDir, "Watch-CodexToast.ps1") & """", 0, False

' Run hidden (0) and wait for completion (True) so process tree stays alive without any visible terminal window
cmdLine = "cmd.exe /d /c """"" & cliCmd & """ > """ & logPath & """ 2>&1"""
exitCode = shell.Run(cmdLine, 0, True)

If exitCode <> 0 Then
    Dim errText, ts
    errText = ""
    If fso.FileExists(logPath) Then
        On Error Resume Next
        Set ts = fso.OpenTextFile(logPath, 1)
        If Err.Number = 0 Then
            errText = ts.ReadAll()
            ts.Close
        End If
        On Error GoTo 0
        If Len(errText) > 800 Then
            errText = Right(errText, 800)
        End If
    End If
    MsgBox "CodexHost exited with error code " & exitCode & "." & vbCrLf & vbCrLf & errText, vbCritical + vbSystemModal, "CodexHost Error"
End If

WScript.Quit exitCode

Function RunHistory(nodePath, action)
    Dim scriptPath, historyLog, historyCommand
    scriptPath = fso.BuildPath(baseDir, "codex-history.mjs")
    historyLog = fso.BuildPath(baseDir, "host-state\" & action & ".log")
    historyCommand = "cmd.exe /d /c """"" & nodePath & """ --disable-warning=ExperimentalWarning """ & scriptPath & """ " & action & " > """ & historyLog & """ 2>&1"""
    RunHistory = shell.Run(historyCommand, 0, True)
End Function

Function ResolveCli(nodePath)
    Dim resolveScript, resolveOut, resolveErr, resolveCmd, rc, ts, line, detail
    resolveScript = fso.BuildPath(baseDir, "resolve-codexhost.mjs")
    resolveOut = fso.BuildPath(shell.ExpandEnvironmentStrings("%TEMP%"), "codexhost-resolve-out.txt")
    resolveErr = fso.BuildPath(shell.ExpandEnvironmentStrings("%TEMP%"), "codexhost-resolve-err.txt")
    resolveCmd = "cmd.exe /d /c """"" & nodePath & """ """ & resolveScript & """ > """ & resolveOut & """ 2> """ & resolveErr & """"""
    rc = shell.Run(resolveCmd, 0, True)
    If rc <> 0 Then
        detail = ""
        If fso.FileExists(resolveErr) Then
            On Error Resume Next
            Set ts = fso.OpenTextFile(resolveErr, 1)
            If Err.Number = 0 Then
                detail = Trim(ts.ReadAll())
                ts.Close
            End If
            On Error GoTo 0
        End If
        If detail = "" Then detail = "resolve-codexhost.mjs exited with code " & rc
        MsgBox "Could not resolve CodexHost CLI:" & vbCrLf & vbCrLf & detail, vbCritical + vbSystemModal, "CodexHost Launcher"
        WScript.Quit rc
    End If
    ResolveCli = ""
    If fso.FileExists(resolveOut) Then
        Set ts = fso.OpenTextFile(resolveOut, 1)
        Do While Not ts.AtEndOfStream
            line = Trim(ts.ReadLine())
            If line <> "" Then
                ResolveCli = line
                Exit Do
            End If
        Loop
        ts.Close
    End If
End Function
