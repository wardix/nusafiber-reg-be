import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { z } from 'zod'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'

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

// Utility functions
async function ensureUploadDir() {
  const uploadDir = path.join(process.cwd(), 'uploads')
  if (!existsSync(uploadDir)) {
    await mkdir(uploadDir, { recursive: true })
  }
  return uploadDir
}

async function saveFile(file: File): Promise<string> {
  const uploadDir = await ensureUploadDir()
  const timestamp = Date.now()
  const extension = path.extname(file.name)
  const filename = `ktp_${timestamp}${extension}`
  const filepath = path.join(uploadDir, filename)

  const buffer = await file.arrayBuffer()
  await writeFile(filepath, new Uint8Array(buffer))

  return filename
}

function validateFile(file: File): { isValid: boolean; error?: string } {
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
      error: 'Format file tidak valid. Gunakan JPG, PNG, atau PDF.',
    }
  }

  if (file.size > maxSize) {
    return {
      isValid: false,
      error: 'Ukuran file terlalu besar. Maksimal 5MB.',
    }
  }

  return { isValid: true }
}

async function saveRegistrationData(data: RegistrationData): Promise<void> {
  const dataDir = path.join(process.cwd(), 'data')
  if (!existsSync(dataDir)) {
    await mkdir(dataDir, { recursive: true })
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `registration_${timestamp}.json`
  const filepath = path.join(dataDir, filename)

  await writeFile(filepath, JSON.stringify(data, null, 2))

  // Also append to main log file
  const logFile = path.join(dataDir, 'registrations.jsonl')
  const logEntry = JSON.stringify(data) + '\n'

  try {
    await writeFile(logFile, logEntry, { flag: 'a' })
  } catch (error) {
    // If file doesn't exist, create it
    await writeFile(logFile, logEntry)
  }
}

// Routes
app.get('/', (c) => {
  return c.json({
    message: 'Nusafiber Selecta API Server',
    version: '1.0.0',
    endpoints: {
      register: 'POST /api/register',
      health: 'GET /api/health',
    },
  })
})

app.get('/api/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
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

    // Basic validation
    if (
      !homepassId ||
      !customerName ||
      !phoneNumber ||
      !locationStr ||
      !ktpFile
    ) {
      return c.json(
        {
          success: false,
          error: 'Missing required fields',
          details:
            'All fields (homepassId, customerName, phoneNumber, location, ktpFile) are required',
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

    // Validate file
    const fileValidation = validateFile(ktpFile)
    if (!fileValidation.isValid) {
      return c.json(
        {
          success: false,
          error: 'File validation failed',
          details: fileValidation.error,
        },
        400,
      )
    }

    // Save file
    let ktpFileName: string
    try {
      ktpFileName = await saveFile(ktpFile)
    } catch (error) {
      console.error('File save error:', error)
      return c.json(
        {
          success: false,
          error: 'Failed to save file',
          details: 'Internal server error during file upload',
        },
        500,
      )
    }

    // Prepare registration data
    const registrationData: RegistrationData = {
      ...validationResult.data,
      ktpFileName,
      submittedAt: new Date().toISOString(),
    }

    // Save registration data
    try {
      await saveRegistrationData(registrationData)
    } catch (error) {
      console.error('Data save error:', error)
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
    const dataDir = path.join(process.cwd(), 'data')
    const logFile = path.join(dataDir, 'registrations.jsonl')

    if (!existsSync(logFile)) {
      return c.json({
        success: true,
        data: [],
        count: 0,
      })
    }

    const content = await Bun.file(logFile).text()
    const lines = content
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
    const registrations = lines.map((line) => JSON.parse(line))

    return c.json({
      success: true,
      data: registrations,
      count: registrations.length,
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

const port = process.env.PORT || 3001

console.log(`🚀 Nusafiber Selecta API Server running on port ${port}`)

export default {
  port,
  fetch: app.fetch,
}
