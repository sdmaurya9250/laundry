import 'dotenv/config'
import express from 'express'

const app = express()
const port = Number(process.env.PORT || 3001)
const requiredEnv = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_DATABASE_ID', 'CLOUDFLARE_API_TOKEN']
const missingEnv = requiredEnv.filter((key) => !process.env[key])

app.use(express.json({ limit: '20kb' }))

async function queryD1(sql, params = []) {
  if (missingEnv.length) throw new Error(`Missing server configuration: ${missingEnv.join(', ')}`)
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${process.env.CLOUDFLARE_DATABASE_ID}/query`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  })
  const payload = await response.json()
  if (!response.ok || !payload.success) {
    const message = payload.errors?.map((error) => error.message).join('; ')
    throw new Error(message || 'Cloudflare D1 request failed.')
  }
  return payload.result?.[0]
}

const ensureSchema = () => queryD1(`CREATE TABLE IF NOT EXISTS garment_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(100) NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  price INTEGER
)`)

async function ensureInvoiceSchema() {
  await queryD1(`CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_no INTEGER NOT NULL UNIQUE,
    customer_name VARCHAR(150) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    invoice_date TEXT NOT NULL,
    ready_on TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    items_total REAL NOT NULL,
    discount_applied INTEGER NOT NULL DEFAULT 0 CHECK (discount_applied IN (0, 1)),
    discount_percent REAL NOT NULL DEFAULT 0,
    discount_amount REAL NOT NULL DEFAULT 0,
    express_service INTEGER NOT NULL DEFAULT 0 CHECK (express_service IN (0, 1)),
    express_fee REAL NOT NULL DEFAULT 0,
    include_gst INTEGER NOT NULL DEFAULT 0 CHECK (include_gst IN (0, 1)),
    gst_amount REAL NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)
  await queryD1(`CREATE TABLE IF NOT EXISTS invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    name VARCHAR(100) NOT NULL,
    rate REAL NOT NULL,
    wash_qty INTEGER NOT NULL DEFAULT 0,
    iron_qty INTEGER NOT NULL DEFAULT 0,
    dry_clean_qty INTEGER NOT NULL DEFAULT 0,
    wash_amount REAL NOT NULL DEFAULT 0,
    iron_amount REAL NOT NULL DEFAULT 0,
    dry_clean_amount REAL NOT NULL DEFAULT 0,
    line_total REAL NOT NULL,
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
  )`)
}

function respondWithDatabaseError(error, response) {
  console.error('Garment database request failed:', error.message)
  response.status(503).json({ error: 'Database is unavailable. Check the backend configuration and try again.' })
}

app.get('/api/health', async (_request, response) => {
  if (missingEnv.length) {
    return response.status(500).json({ ok: false, error: `Missing env: ${missingEnv.join(', ')}` })
  }
  try {
    const result = await queryD1('SELECT 1 AS ok')
    response.json({ ok: true, db: result.results[0] })
  } catch (error) {
    response.status(503).json({ ok: false, error: error.message })
  }
})

app.get('/api/garment-types', async (_request, response) => {
  try {
    await ensureSchema()
    const result = await queryD1('SELECT id, name, active, price FROM garment_types ORDER BY name COLLATE NOCASE')
    response.json({ garments: result.results.map((item) => ({ ...item, active: Boolean(item.active), price: Number(item.price ?? 0) })) })
  } catch (error) {
    respondWithDatabaseError(error, response)
  }
})

app.post('/api/garment-types', async (request, response) => {
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
  const price = request.body?.price
  const active = request.body?.active === false ? 0 : 1
  if (!name || name.length > 100) return response.status(400).json({ error: 'Enter a garment name between 1 and 100 characters.' })
  if (!Number.isSafeInteger(price) || price < 0) return response.status(400).json({ error: 'Price must be a whole number greater than or equal to zero.' })

  try {
    await ensureSchema()
    const result = await queryD1('INSERT INTO garment_types (name, active, price) VALUES (?, ?, ?) RETURNING id, name, active, price', [name, active, price])
    const garment = result.results[0]
    response.status(201).json({ garment: { ...garment, active: Boolean(garment.active), price: Number(garment.price) } })
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) return response.status(409).json({ error: 'A garment with that name already exists.' })
    respondWithDatabaseError(error, response)
  }
})

function mapInvoice(invoice, items) {
  return {
    id: invoice.id,
    invoiceNo: invoice.invoice_no,
    customerName: invoice.customer_name,
    phone: invoice.phone,
    invoiceDate: invoice.invoice_date,
    readyOn: invoice.ready_on,
    notes: invoice.notes,
    itemsTotal: Number(invoice.items_total),
    applyDiscount: Boolean(invoice.discount_applied),
    discountPercent: Number(invoice.discount_percent),
    discountAmount: Number(invoice.discount_amount),
    expressService: Boolean(invoice.express_service),
    expressFee: Number(invoice.express_fee),
    includeGST: Boolean(invoice.include_gst),
    gstAmount: Number(invoice.gst_amount),
    totalAmount: Number(invoice.total_amount),
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      rate: Number(item.rate),
      wash: Number(item.wash_qty),
      iron: Number(item.iron_qty),
      dryClean: Number(item.dry_clean_qty),
      washAmount: Number(item.wash_amount),
      ironAmount: Number(item.iron_amount),
      dryCleanAmount: Number(item.dry_clean_amount),
      total: Number(item.line_total),
    })),
  }
}

app.post('/api/invoices', async (request, response) => {
  const body = request.body ?? {}
  const customerName = typeof body.customerName === 'string' ? body.customerName.trim() : ''
  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
  const readyOn = typeof body.readyOn === 'string' ? body.readyOn : ''
  const invoiceDate = typeof body.invoiceDate === 'string' ? body.invoiceDate : ''
  const notes = typeof body.notes === 'string' ? body.notes.trim() : ''
  const items = Array.isArray(body.items) ? body.items : []
  const discountPercent = Number(body.discountPercent)
  const applyDiscount = Boolean(body.applyDiscount)
  const expressService = Boolean(body.expressService)
  const includeGST = Boolean(body.includeGST)

  if (!customerName || customerName.length > 150) return response.status(400).json({ error: 'Enter a customer name up to 150 characters.' })
  if (!phone || phone.length > 30) return response.status(400).json({ error: 'Enter a phone number up to 30 characters.' })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(readyOn) || !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) return response.status(400).json({ error: 'Enter a valid invoice date and ready date.' })
  if (notes.length > 2000) return response.status(400).json({ error: 'Notes must be 2,000 characters or fewer.' })
  if (!items.length || items.length > 100) return response.status(400).json({ error: 'Add between 1 and 100 invoice items.' })
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) return response.status(400).json({ error: 'Discount must be between 0 and 100 percent.' })

  const cleanItems = []
  for (const item of items) {
    const name = typeof item?.name === 'string' ? item.name.trim() : ''
    const rate = Number(item?.rate)
    const wash = Number(item?.wash)
    const iron = Number(item?.iron)
    const dryClean = Number(item?.dryClean)
    if (!name || name.length > 100 || !Number.isSafeInteger(rate) || rate < 0) return response.status(400).json({ error: 'Each item needs a name and a whole-number rate of zero or more.' })
    if (![wash, iron, dryClean].every((qty) => Number.isSafeInteger(qty) && qty >= 0)) return response.status(400).json({ error: 'Service quantities must be whole numbers of zero or more.' })
    cleanItems.push({ name, rate, wash, iron, dryClean })
  }

  const itemsTotal = cleanItems.reduce((sum, item) => sum + (item.wash + item.iron + item.dryClean) * item.rate, 0)
  const discountAmount = applyDiscount ? Math.round(itemsTotal * discountPercent) / 100 : 0
  const expressFee = expressService ? 50 : 0
  const subtotal = Math.max(0, itemsTotal - discountAmount + expressFee)
  const gstAmount = includeGST ? Math.round(subtotal * 18) / 100 : 0
  const totalAmount = subtotal + gstAmount

  try {
    await ensureInvoiceSchema()
    const created = await queryD1(`INSERT INTO invoices (
      invoice_no, customer_name, phone, invoice_date, ready_on, notes, items_total,
      discount_applied, discount_percent, discount_amount, express_service, express_fee,
      include_gst, gst_amount, total_amount
    ) VALUES (
      (SELECT COUNT(*) + 1 FROM invoices), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    ) RETURNING id, invoice_no`, [
      customerName, phone, invoiceDate, readyOn, notes, itemsTotal,
      applyDiscount ? 1 : 0, discountPercent, discountAmount, expressService ? 1 : 0,
      expressFee, includeGST ? 1 : 0, gstAmount, totalAmount,
    ])
    const createdInvoice = created.results[0]
    try {
      for (const item of cleanItems) {
        const washAmount = item.wash * item.rate
        const ironAmount = item.iron * item.rate
        const dryCleanAmount = item.dryClean * item.rate
        await queryD1(`INSERT INTO invoice_items (
          invoice_id, name, rate, wash_qty, iron_qty, dry_clean_qty,
          wash_amount, iron_amount, dry_clean_amount, line_total
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          createdInvoice.id, item.name, item.rate, item.wash, item.iron, item.dryClean,
          washAmount, ironAmount, dryCleanAmount, washAmount + ironAmount + dryCleanAmount,
        ])
      }
    } catch (itemError) {
      await queryD1('DELETE FROM invoice_items WHERE invoice_id = ?', [createdInvoice.id]).catch(() => {})
      await queryD1('DELETE FROM invoices WHERE id = ?', [createdInvoice.id]).catch(() => {})
      throw itemError
    }
    const responseInvoice = {
      ...createdInvoice,
      customer_name: customerName,
      phone,
      invoice_date: invoiceDate,
      ready_on: readyOn,
      notes,
      items_total: itemsTotal,
      discount_applied: applyDiscount ? 1 : 0,
      discount_percent: discountPercent,
      discount_amount: discountAmount,
      express_service: expressService ? 1 : 0,
      express_fee: expressFee,
      include_gst: includeGST ? 1 : 0,
      gst_amount: gstAmount,
      total_amount: totalAmount,
    }
    const responseItems = cleanItems.map((item, index) => ({
      ...item,
      id: index + 1,
      wash_qty: item.wash,
      iron_qty: item.iron,
      dry_clean_qty: item.dryClean,
      wash_amount: item.wash * item.rate,
      iron_amount: item.iron * item.rate,
      dry_clean_amount: item.dryClean * item.rate,
      line_total: (item.wash + item.iron + item.dryClean) * item.rate,
    }))
    response.status(201).json({ invoice: mapInvoice(responseInvoice, responseItems) })
  } catch (error) {
    respondWithDatabaseError(error, response)
  }
})

app.get('/api/invoices/next-number', async (_request, response) => {
  try {
    await ensureInvoiceSchema()
    const result = await queryD1('SELECT COUNT(*) + 1 AS invoice_no FROM invoices')
    response.json({ invoiceNo: Number(result.results[0].invoice_no) })
  } catch (error) {
    respondWithDatabaseError(error, response)
  }
})

app.get('/api/invoices', async (_request, response) => {
  try {
    await ensureInvoiceSchema()
    const result = await queryD1(`SELECT
      i.id,
      i.invoice_no,
      i.customer_name,
      i.phone,
      i.invoice_date,
      i.ready_on,
      i.notes,
      i.items_total,
      i.discount_amount,
      i.express_fee,
      i.gst_amount,
      i.total_amount,
      i.created_at,
      COUNT(ii.id) AS item_count,
      COALESCE(SUM(ii.wash_qty + ii.iron_qty + ii.dry_clean_qty), 0) AS pieces_count,
      GROUP_CONCAT(DISTINCT ii.name) AS garments
    FROM invoices i
    LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
    GROUP BY i.id
    ORDER BY i.id DESC`)
    response.json({ invoices: result.results.map((invoice) => ({
      id: Number(invoice.id),
      invoiceNo: Number(invoice.invoice_no),
      customerName: invoice.customer_name,
      phone: invoice.phone,
      invoiceDate: invoice.invoice_date,
      readyOn: invoice.ready_on,
      notes: invoice.notes,
      itemsTotal: Number(invoice.items_total),
      discountAmount: Number(invoice.discount_amount),
      expressFee: Number(invoice.express_fee),
      gstAmount: Number(invoice.gst_amount),
      totalAmount: Number(invoice.total_amount),
      createdAt: invoice.created_at,
      itemCount: Number(invoice.item_count),
      piecesCount: Number(invoice.pieces_count),
      garments: invoice.garments || '',
    })) })
  } catch (error) {
    respondWithDatabaseError(error, response)
  }
})

app.get('/api/invoices/:id', async (request, response) => {
  const id = Number(request.params.id)
  if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: 'Invalid invoice ID.' })
  try {
    await ensureInvoiceSchema()
    const [invoiceResult, itemsResult] = await Promise.all([
      queryD1('SELECT * FROM invoices WHERE id = ?', [id]),
      queryD1('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id', [id]),
    ])
    const invoice = invoiceResult.results[0]
    if (!invoice) return response.status(404).json({ error: 'Invoice not found.' })
    response.json({ invoice: mapInvoice(invoice, itemsResult.results) })
  } catch (error) {
    respondWithDatabaseError(error, response)
  }
})

app.listen(port, '127.0.0.1', () => {
  console.log(`Garment API listening on http://localhost:${port}`)
})
