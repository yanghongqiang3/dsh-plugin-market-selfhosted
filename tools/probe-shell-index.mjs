/**
 * Fetch the real shell index through the dsh web token exchange, so the
 * injection paths can be inspected. Read-only probe.
 *
 *   node tools/probe-shell-index.mjs <baseUrl> <token>
 */
const base = (process.argv[2] ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
const token = process.argv[3] ?? null

/** Minimal cookie jar: the token exchange answers a Set-Cookie the index needs. */
let cookie = null

async function get(path) {
  const response = await fetch(`${base}${path}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  })
  const setCookie = response.headers.getSetCookie?.() ?? []
  if (setCookie.length > 0) {
    cookie = setCookie.map((entry) => entry.split(';')[0]).join('; ')
    console.log(`    (收到 cookie: ${cookie.slice(0, 40)}…)`)
  }
  return response
}

if (token) {
  console.log('--- token 交换 ---')
  const exchanged = await get(`/?token=${token}`)
  console.log(`    HTTP ${exchanged.status}  location=${exchanged.headers.get('location') ?? '(无)'}`)
  console.log('')
}

for (const [label, path] of [
  ['根路径', '/'],
  ['index.html', '/index.html'],
  ['不存在的路径', '/no-such-path-xyz'],
  ['/market', '/market'],
]) {
  try {
    const response = await get(path)
    const text = await response.text()
    console.log(`--- ${label} (${path}): HTTP ${response.status}  ${text.length} 字节`)
    console.log(`    content-type: ${response.headers.get('content-type')}`)
    if (text.length < 500) {
      console.log(`    body: ${JSON.stringify(text.slice(0, 300))}`)
    } else {
      for (const [name, present] of [
        ['<div id="root">', text.includes('id="root"')],
        ['type="module"', text.includes('type="module"')],
        ['__DSH_BOOT__', text.includes('__DSH_BOOT__')],
        ['注入的入口 id', text.includes('dsh-marketplace-entry')],
      ]) {
        console.log(`    ${present ? '有' : '无'}  ${name}`)
      }
      console.log(`    开头 260: ${JSON.stringify(text.slice(0, 260))}`)
      console.log(`    结尾 200: ${JSON.stringify(text.slice(-200))}`)
    }
  } catch (error) {
    console.log(`--- ${label}: 请求失败 ${error?.message ?? error}`)
  }
  console.log('')
}
