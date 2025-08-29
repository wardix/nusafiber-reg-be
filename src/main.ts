import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { z } from 'zod'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
})

const app = new Hono()

// Middleware
app.use('*', logger())
app.use(
  '*',
  cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
)

// Types
interface RegistrationData {
  homepassId: string
  customerName: string
  phoneNumber: string
  location: {
    lat: number
    lng: number
    address: string
  }
  ktpFileName?: string
  housePhotoFileName?: string
  submittedAt: string
}

// Validation schemas
const homepassIdSchema = z
  .string()
  .regex(
    /^[A-Z0-9]{4}-[A-Z0-9]{5}-H[0-9]{5}$/,
    'Format Homepass ID tidak valid',
  )

const phoneSchema = z
  .string()
  .min(10, 'Nomor handphone minimal 10 digit')
  .max(13, 'Nomor handphone maksimal 13 digit')
  .regex(
    /^0[0-9]+$/,
    'Nomor handphone harus dimulai dengan 0 dan hanya berisi angka',
  )

const locationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  address: z.string().min(1, 'Alamat tidak boleh kosong'),
})

const registrationSchema = z.object({
  homepassId: homepassIdSchema,
  customerName: z
    .string()
    .min(2, 'Nama minimal 2 karakter')
    .max(100, 'Nama maksimal 100 karakter'),
  phoneNumber: phoneSchema,
  location: locationSchema,
})

// Database initialization
async function initializeDatabase() {
  try {
    const connection = await pool.getConnection()

    // Create registrations table if it doesn't exist
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS registrations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        homepass_id VARCHAR(20) NOT NULL UNIQUE,
        customer_name VARCHAR(100) NOT NULL,
        phone_number VARCHAR(13) NOT NULL,
        lat DECIMAL(10, 8) NOT NULL,
        lng DECIMAL(11, 8) NOT NULL,
        address TEXT NOT NULL,
        ktp_file_name VARCHAR(255),
        house_photo_file_name VARCHAR(255),
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_homepass_id (homepass_id),
        INDEX idx_submitted_at (submitted_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `

    await connection.execute(createTableQuery)
    connection.release()

    console.log('✅ Database table initialized successfully')
  } catch (error) {
    console.error('❌ Failed to initialize database:', error)
    throw error
  }
}

// Utility functions
async function ensureUploadDir() {
  const uploadDir = path.join(process.cwd(), 'uploads')
  if (!existsSync(uploadDir)) {
    await mkdir(uploadDir, { recursive: true })
  }
  return uploadDir
}

async function saveFile(file: File, prefix: string): Promise<string> {
  const uploadDir = await ensureUploadDir()
  const timestamp = Date.now()
  const extension = path.extname(file.name)
  const filename = `${prefix}_${timestamp}${extension}`
  const filepath = path.join(uploadDir, filename)

  const buffer = await file.arrayBuffer()
  await writeFile(filepath, new Uint8Array(buffer))

  return filename
}

function validateKTPFile(file: File): { isValid: boolean; error?: string } {
  const allowedTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'application/pdf',
  ]
  const maxSize = 5 * 1024 * 1024 // 5MB

  if (!allowedTypes.includes(file.type)) {
    return {
      isValid: false,
      error: 'Format file KTP tidak valid. Gunakan JPG, PNG, atau PDF.',
    }
  }

  if (file.size > maxSize) {
    return {
      isValid: false,
      error: 'Ukuran file KTP terlalu besar. Maksimal 5MB.',
    }
  }

  return { isValid: true }
}

function validateHousePhotoFile(file: File): {
  isValid: boolean
  error?: string
} {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png']
  const maxSize = 5 * 1024 * 1024 // 5MB

  if (!allowedTypes.includes(file.type)) {
    return {
      isValid: false,
      error: 'Format foto rumah tidak valid. Gunakan JPG atau PNG.',
    }
  }

  if (file.size > maxSize) {
    return {
      isValid: false,
      error: 'Ukuran foto rumah terlalu besar. Maksimal 5MB.',
    }
  }

  return { isValid: true }
}

async function saveRegistrationData(data: RegistrationData): Promise<void> {
  try {
    const connection = await pool.getConnection()

    const insertQuery = `
      INSERT INTO registrations 
      (homepass_id, customer_name, phone_number, lat, lng, address, ktp_file_name, house_photo_file_name, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `

    const values = [
      data.homepassId,
      data.customerName,
      data.phoneNumber,
      data.location.lat,
      data.location.lng,
      data.location.address,
      data.ktpFileName,
      data.housePhotoFileName,
      data.submittedAt,
    ]

    await connection.execute(insertQuery, values)
    connection.release()

    console.log(`✅ Registration data saved for ${data.homepassId}`)
  } catch (error) {
    console.error('❌ Failed to save registration data:', error)
    throw error
  }
}

// Check if homepass ID already exists
async function checkHomepassIdExists(homepassId: string): Promise<boolean> {
  try {
    const connection = await pool.getConnection()

    const checkQuery = `
      SELECT COUNT(*) as count FROM registrations 
      WHERE homepass_id = ?
    `

    const [rows] = (await connection.execute(checkQuery, [homepassId])) as any[]
    connection.release()

    return rows[0].count > 0
  } catch (error) {
    console.error('❌ Failed to check homepass ID:', error)
    throw error
  }
}

// Routes
app.get('/', (c) => {
  return c.json({
    message: 'Nusafiber Selecta API Server',
    version: '1.0.0',
    endpoints: {
      register: 'POST /api/register',
      registrations: 'GET /api/registrations',
      health: 'GET /api/health',
    },
  })
})

app.get('/api/health', async (c) => {
  try {
    // Test database connection
    const connection = await pool.getConnection()
    await connection.ping()
    connection.release()

    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: 'connected',
    })
  } catch (error) {
    return c.json(
      {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: 'disconnected',
        error:
          error instanceof Error ? error.message : 'Database connection failed',
      },
      503,
    )
  }
})

// Registration endpoint
app.post('/api/register', async (c) => {
  try {
    const formData = await c.req.formData()

    // Extract form fields
    const homepassId = formData.get('homepassId') as string
    const customerName = formData.get('customerName') as string
    const phoneNumber = formData.get('phoneNumber') as string
    const locationStr = formData.get('location') as string
    const ktpFile = formData.get('ktpFile') as File
    const housePhotoFile = formData.get('housePhotoFile') as File

    // Basic validation
    if (
      !homepassId ||
      !customerName ||
      !phoneNumber ||
      !locationStr ||
      !ktpFile ||
      !housePhotoFile
    ) {
      return c.json(
        {
          success: false,
          error: 'Missing required fields',
          details:
            'All fields (homepassId, customerName, phoneNumber, location, ktpFile, housePhotoFile) are required',
        },
        400,
      )
    }

    // Parse location
    let location
    try {
      location = JSON.parse(locationStr)
    } catch (error) {
      return c.json(
        {
          success: false,
          error: 'Invalid location format',
          details: 'Location must be valid JSON',
        },
        400,
      )
    }

    // Validate form data using Zod
    const validationResult = registrationSchema.safeParse({
      homepassId,
      customerName: customerName.trim(),
      phoneNumber,
      location,
    })

    if (!validationResult.success) {
      return c.json(
        {
          success: false,
          error: 'Validation failed',
          details: validationResult.error.issues,
        },
        400,
      )
    }

    // Check if homepass ID already exists
    const exists = await checkHomepassIdExists(homepassId)
    if (exists) {
      return c.json(
        {
          success: false,
          error: 'Duplicate registration',
          details: 'Homepass ID sudah terdaftar sebelumnya',
        },
        409,
      )
    }

    // Validate KTP file
    const ktpFileValidation = validateKTPFile(ktpFile)
    if (!ktpFileValidation.isValid) {
      return c.json(
        {
          success: false,
          error: 'KTP file validation failed',
          details: ktpFileValidation.error,
        },
        400,
      )
    }

    // Validate house photo file
    const housePhotoValidation = validateHousePhotoFile(housePhotoFile)
    if (!housePhotoValidation.isValid) {
      return c.json(
        {
          success: false,
          error: 'House photo file validation failed',
          details: housePhotoValidation.error,
        },
        400,
      )
    }

    // Save files
    let ktpFileName: string
    let housePhotoFileName: string

    try {
      ktpFileName = await saveFile(ktpFile, 'ktp')
      housePhotoFileName = await saveFile(housePhotoFile, 'house_photo')
    } catch (error) {
      console.error('File save error:', error)
      return c.json(
        {
          success: false,
          error: 'Failed to save files',
          details: 'Internal server error during file upload',
        },
        500,
      )
    }

    // Prepare registration data
    const registrationData: RegistrationData = {
      ...validationResult.data,
      ktpFileName,
      housePhotoFileName,
      submittedAt: new Date().toISOString(),
    }

    // Save registration data to database
    try {
      await saveRegistrationData(registrationData)
    } catch (error) {
      console.error('Database save error:', error)
      return c.json(
        {
          success: false,
          error: 'Failed to save registration data',
          details: 'Internal server error during data storage',
        },
        500,
      )
    }

    // Success response
    return c.json({
      success: true,
      message: 'Pendaftaran berhasil disimpan',
      data: {
        homepassId: registrationData.homepassId,
        customerName: registrationData.customerName,
        submittedAt: registrationData.submittedAt,
        referenceId: `NSF-${Date.now()}`,
        ktpFileName: registrationData.ktpFileName,
        housePhotoFileName: registrationData.housePhotoFileName,
      },
    })
  } catch (error) {
    console.error('Registration error:', error)
    return c.json(
      {
        success: false,
        error: 'Internal server error',
        details:
          error instanceof Error ? error.message : 'Unknown error occurred',
      },
      500,
    )
  }
})

// Get registrations (for admin)
app.get('/api/registrations', async (c) => {
  try {
    const connection = await pool.getConnection()

    // Get query parameters for pagination
    const page = parseInt(c.req.query('page') || '1')
    const limit = parseInt(c.req.query('limit') || '50')
    const offset = (page - 1) * limit

    // Get total count
    const [countResult] = (await connection.execute(
      'SELECT COUNT(*) as total FROM registrations',
    )) as any[]
    const total = countResult[0].total

    // Get registrations with pagination
    const [rows] = (await connection.execute(
      `
      SELECT 
        id,
        homepass_id,
        customer_name,
        phone_number,
        lat,
        lng,
        address,
        ktp_file_name,
        house_photo_file_name,
        submitted_at,
        created_at,
        updated_at
      FROM registrations 
      ORDER BY submitted_at DESC
      LIMIT ? OFFSET ?
    `,
      [limit, offset],
    )) as any[]

    connection.release()

    // Transform data to match original format
    const registrations = rows.map((row: any) => ({
      homepassId: row.homepass_id,
      customerName: row.customer_name,
      phoneNumber: row.phone_number,
      location: {
        lat: parseFloat(row.lat),
        lng: parseFloat(row.lng),
        address: row.address,
      },
      ktpFileName: row.ktp_file_name,
      housePhotoFileName: row.house_photo_file_name,
      submittedAt: row.submitted_at,
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))

    return c.json({
      success: true,
      data: registrations,
      count: registrations.length,
      total: total,
      page: page,
      totalPages: Math.ceil(total / limit),
    })
  } catch (error) {
    console.error('Get registrations error:', error)
    return c.json(
      {
        success: false,
        error: 'Failed to retrieve registrations',
        details:
          error instanceof Error ? error.message : 'Unknown error occurred',
      },
      500,
    )
  }
})

// Get single registration by homepass ID
app.get('/api/registrations/:homepassId', async (c) => {
  try {
    const homepassId = c.req.param('homepassId')
    const connection = await pool.getConnection()

    const [rows] = (await connection.execute(
      `
      SELECT 
        id,
        homepass_id,
        customer_name,
        phone_number,
        lat,
        lng,
        address,
        ktp_file_name,
        house_photo_file_name,
        submitted_at,
        created_at,
        updated_at
      FROM registrations 
      WHERE homepass_id = ?
    `,
      [homepassId],
    )) as any[]

    connection.release()

    if (rows.length === 0) {
      return c.json(
        {
          success: false,
          error: 'Registration not found',
          details: 'No registration found with the specified Homepass ID',
        },
        404,
      )
    }

    const row = rows[0]
    const registration = {
      homepassId: row.homepass_id,
      customerName: row.customer_name,
      phoneNumber: row.phone_number,
      location: {
        lat: parseFloat(row.lat),
        lng: parseFloat(row.lng),
        address: row.address,
      },
      ktpFileName: row.ktp_file_name,
      housePhotoFileName: row.house_photo_file_name,
      submittedAt: row.submitted_at,
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }

    return c.json({
      success: true,
      data: registration,
    })
  } catch (error) {
    console.error('Get registration error:', error)
    return c.json(
      {
        success: false,
        error: 'Failed to retrieve registration',
        details:
          error instanceof Error ? error.message : 'Unknown error occurred',
      },
      500,
    )
  }
})

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: 'Not found',
      message: 'The requested endpoint does not exist',
    },
    404,
  )
})

// Global error handler
app.onError((err, c) => {
  console.error('Global error handler:', err)
  return c.json(
    {
      success: false,
      error: 'Internal server error',
      details: err.message,
    },
    500,
  )
})

// Initialize database and start server
const port = process.env.PORT || 3001

async function startServer() {
  try {
    // Initialize database first
    await initializeDatabase()

    console.log(`🚀 Nusafiber Selecta API Server running on port ${port}`)
    console.log(`📊 Database: MySQL`)
    console.log(`📁 File uploads: ./uploads/`)

    Bun.serve({
      port,
      fetch: app.fetch,
    })
  } catch (error) {
    console.error('❌ Failed to start server:', error)
    process.exit(1)
  }
}

startServer()
