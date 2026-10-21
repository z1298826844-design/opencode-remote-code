#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const entry = path.join(__dirname, '..', 'dist', 'cli', 'index.js')
if (!fs.existsSync(entry)) {
  console.error('请在源码目录运行 npm run setup，然后重试 opencode-remote。')
  process.exitCode = 1
} else {
  import(pathToFileURL(entry).href).then(({ main }) => main()).catch(error => {
    console.error(`opencode-remote: ${error.message}`)
    process.exitCode = error.code === 'CANCELLED' ? 130 : 1
  })
}
