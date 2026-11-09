// Executed by the host management command inside the existing API container.
// The password arrives via stdin, never a command argument or environment value.
async function setAdminPassword(db, hash, email, password) {
  if (typeof password !== 'string' || password.length < 16 || Buffer.byteLength(password, 'utf8') > 72 || /[\r\n\0]/.test(password)) {
    throw Error('Нужен пароль от 16 символов, не более 72 байт, без перевода строки')
  }
  if (typeof email !== 'string' || !email.trim()) throw Error('Не указан email администратора')
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } })
  if (!user || !user.isActive || !['ADMIN', 'DIRECTOR'].includes(user.role)) {
    throw Error('Активный администратор с таким email не найден; аккаунты не изменены')
  }
  await db.user.update({ where: { id: user.id }, data: { passwordHash: await hash(password, 12) } })
}
module.exports = { setAdminPassword }
if (!module.parent) {
  const { PrismaClient } = require('@prisma/client')
  const bcrypt = require('bcryptjs')
  const db = new PrismaClient()
  const [email, password] = require('node:fs').readFileSync(0, 'utf8').split('\0')
  setAdminPassword(db, bcrypt.hash, email, password)
    .then(() => console.log('Пароль администратора обновлён.'))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
    .finally(() => db.$disconnect())
}
