import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import { TerminalPrompt } from '../dist/cli/prompt.js'

function terminal(columns = 100) {
  const input = new PassThrough()
  input.isTTY = true
  input.setRawMode = value => { input.isRaw = value }
  let written = ''
  const output = new Writable({ write(chunk, _encoding, callback) {
    written += chunk.toString()
    callback()
  } })
  output.isTTY = true
  output.columns = columns
  return { input, output, prompt: new TerminalPrompt(input, output), transcript: () => written }
}

// readline erases from the cursor to the end of the screen before repainting.
// Text emitted before the latest erase is NOT proof that a prompt is still visible.
function latestPaint(transcript) {
  const erase = '\x1b[0J'
  const index = transcript.lastIndexOf(erase)
  assert.notEqual(index, -1, 'Exercise a real readline repaint')
  return stripVTControlCharacters(transcript.slice(index + erase.length))
}

test('required prompt survives initial readline erase and subsequent editing', async () => {
  const { prompt, input, transcript } = terminal()
  const pending = prompt.text('服务器 IP / 主机名（必填）')
  assert(latestPaint(transcript()).includes('服务器 IP / 主机名（必填）： '))
  input.write('hosx')
  input.write('\x7f') // backspace forces another repaint
  input.write('t')
  assert(latestPaint(transcript()).includes('服务器 IP / 主机名（必填）'))
  input.write('\r')
  assert.equal(await pending, 'host')
  assert.equal(input.isRaw, false)
})

test('default value and Enter behavior are visible, including on a narrow terminal', async () => {
  const { prompt, input, transcript } = terminal(24)
  const pending = prompt.text('SSH 端口', '22')
  const paint = latestPaint(transcript())
  assert(paint.includes('SSH 端口'))
  assert(paint.includes('回车使用：22'))
  input.write('\r')
  assert.equal(await pending, '22')
})

test('secret prompt stays visible while typing and resizing never reveals the password', async () => {
  const { prompt, input, output, transcript } = terminal()
  const pending = prompt.text('SSH 登录密码', '', true)
  const initialPaint = latestPaint(transcript())
  assert(initialPaint.includes('SSH 登录密码： '))
  input.write('hidden-password')
  output.columns = 32
  output.emit('resize')
  assert.equal(latestPaint(transcript()), initialPaint)
  input.write('\r')
  assert.equal(await pending, 'hidden-password')
  assert(!transcript().includes('hidden-password'))
  assert.equal(input.isRaw, false)
  assert.equal(output.listenerCount('resize'), 0)
})

test('yes/no prompt explains its choices and defaults', async () => {
  const { prompt, input, transcript } = terminal()
  const pending = prompt.confirm('需要 sudo 密码吗')
  const paint = latestPaint(transcript())
  assert(paint.includes('y=是，n=否，回车默认否'))
  input.write('\r')
  assert.equal(await pending, false)
})

test('cancelling either prompt restores terminal mode and starts a fresh line', async () => {
  for (const secret of [false, true]) {
    const { prompt, input, transcript } = terminal()
    const pending = prompt.text('输入内容', '', secret)
    input.write('\x03')
    await assert.rejects(pending, { code: 'CANCELLED' })
    assert.equal(input.isRaw, false)
    assert(transcript().endsWith('\n'))
  }
})

test('redirected input fails without leaving an invisible prompt', async () => {
  const { prompt, input, transcript } = terminal()
  input.isTTY = false
  await assert.rejects(prompt.text('SSH command'), /需要交互输入/)
  assert.equal(transcript(), '')
})
