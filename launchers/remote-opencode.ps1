# Compatibility entry; the installed global command is opencode-remote.
& node (Join-Path $PSScriptRoot '../bin/opencode-remote.cjs') @args
exit $LASTEXITCODE
