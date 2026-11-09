import assert from 'node:assert/strict'
import test from 'node:test'
import { extractText, splitMessage } from '../lib/ilink.js'
import { Deduper } from '../lib/store.js'

test('extractText returns plain text', () => {
  assert.equal(extractText([{ type: 1, text_item: { text: '你好' } }]), '你好')
})

test('extractText prefixes a quoted media reference', () => {
  const item = {
    type: 1,
    text_item: { text: '这张图什么意思' },
    ref_msg: { title: '照片', message_item: { type: 2 } },
  }
  assert.equal(extractText([item]), '[引用媒体: 照片]\n这张图什么意思')
})

test('extractText prefixes a quoted text reference', () => {
  const item = {
    type: 1,
    text_item: { text: '继续' },
    ref_msg: { title: '上一条', message_item: { type: 1, text_item: { text: '原始内容' } } },
  }
  assert.equal(extractText([item]), '[引用: 上一条 | 原始内容]\n继续')
})

test('extractText trusts a Weixin voice transcript only without media', () => {
  assert.equal(
    extractText([{ type: 3, voice_item: { text: '语音转写' } }]),
    '[Voice transcription provided by Weixin]\n语音转写',
  )
  assert.equal(extractText([{ type: 3, voice_item: { text: 'x', media: {} } }]), '')
})

test('splitMessage keeps short text in one chunk', () => {
  assert.deepEqual(splitMessage('很短的一句话'), ['很短的一句话'])
  assert.deepEqual(splitMessage('   '), [])
})

test('splitMessage splits oversized paragraphs without losing text', () => {
  const long = 'x'.repeat(4500)
  const chunks = splitMessage(long, 2000)
  assert.equal(chunks.length, 3)
  assert.equal(chunks.join(''), long)
  for (const chunk of chunks) assert.ok(chunk.length <= 2000)
})

test('splitMessage prefers paragraph boundaries', () => {
  const text = `${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}`
  const chunks = splitMessage(text, 2000)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0], 'a'.repeat(1500))
})

test('Deduper forgets keys after the window', async () => {
  const sticky = new Deduper(60_000)
  assert.equal(sticky.duplicate('k'), false)
  assert.equal(sticky.duplicate('k'), true)

  const expiring = new Deduper(1)
  assert.equal(expiring.duplicate('k'), false)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(expiring.duplicate('k'), false)
})
