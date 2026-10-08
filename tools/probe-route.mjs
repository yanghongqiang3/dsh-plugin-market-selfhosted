// Raw HTTP probe: report status, content-type and body prefix so a route that
// answers 400 can explain itself instead of being guessed at.
import { request } from 'node:http'

const [base, ...paths] = process.argv.slice(2)
for (const path of paths) {
  await new Promise((resolve) => {
    const req = request(`${base}${path}`, { method: 'GET' }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        console.log(`${String(res.statusCode).padEnd(4)} ${path}`)
        console.log(`     content-type: ${res.headers['content-type'] ?? '(none)'}`)
        console.log(`     content-length: ${res.headers['content-length'] ?? '(none)'}`)
        console.log(`     body: ${JSON.stringify(body.slice(0, 200))}`)
        resolve()
      })
    })
    req.on('error', (error) => {
      console.log(`ERR  ${path} — ${error.message}`)
      resolve()
    })
    req.end()
  })
}
