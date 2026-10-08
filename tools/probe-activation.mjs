/**
 * Ask a running dsh web instance for the real reason a client row failed.
 *
 * `dsh-app-boot` prints only "N entry did not activate …: failed to import"; the
 * underlying error is held by the browser half and surfaced through the shell's
 * Plugin inventory. This drives its API to read that record.
 *
 *   node tools/probe-activation.mjs <baseUrl> <token>
 */
const BASE = (process.argv[2] ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
const TOKEN = process.argv[3]

let cookie = null
async function get(path) {
  const response = await fetch(`${BASE}${path}`, {
    redirect: 'manual',
    headers: {
      accept: 'application/json',
      ...(cookie ? { cookie } : {}),
    },
  })
  const setCookie = response.headers.getSetCookie?.() ?? []
  if (setCookie.length > 0) cookie = setCookie.map((entry) => entry.split(';')[0]).join('; ')
  return response
}

if (TOKEN) {
  const exchanged = await get(`/?token=${TOKEN}`)
  console.log(`token 交换: HTTP ${exchanged.status}`)
}

console.log('')
for (const path of [
  '/api/client-modules/manifest',
  '/api/client-modules/state',
  '/plugins/dsh-plugin-marketplace/client.js',
  '/plugins/??dsh-plugin-marketplace/client.js',
  '/dsh-market/open',
  '/dsh-market/config',
]) {
  try {
    const response = await get(path)
    const text = await response.text()
    console.log(`--- ${path}: HTTP ${response.status}  ${text.length} 字节  ${response.headers.get('content-type')}`)
    if (text.length < 700) console.log(`    ${JSON.stringify(text.slice(0, 600))}`)
  } catch (error) {
    console.log(`--- ${path}: 失败 ${String(error).slice(0, 90)}`)
  }
}
