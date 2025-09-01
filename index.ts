import { Hono } from 'hono'
import { S3Client } from 'bun'

const app = new Hono()

interface R2Config {
  accessKeyId: string
  secretAccessKey: string
  endpoint: string
  bucket: string
}

const validateAuthKey = (authKey: string): boolean => {
  return authKey && authKey.length > 0
}

app.post('/upload', async (c) => {
  try {
    console.log('Upload request received')
    const authKey = c.req.header('Authorization')
    console.log('Auth key:', authKey)
    
    if (!validateAuthKey(authKey)) {
      return c.json({ error: 'Invalid or missing authorization key' }, 401)
    }

    console.log('Parsing form data...')
    const formData = await c.req.formData()
    console.log('Form data keys:', Array.from(formData.keys()))
    
    const accessKeyId = formData.get('accessKeyId') as string
    const secretAccessKey = formData.get('secretAccessKey') as string
    const endpoint = formData.get('endpoint') as string
    const bucket = formData.get('bucket') as string

    console.log('Config received:', { accessKeyId: accessKeyId ? 'present' : 'missing', secretAccessKey: secretAccessKey ? 'present' : 'missing', endpoint, bucket })

    if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
      return c.json({ error: 'Missing R2/S3 configuration parameters' }, 400)
    }

    console.log('Creating S3 client...')
    const s3Client = new S3Client({
      accessKeyId,
      secretAccessKey,
      endpoint,
      region: 'auto',
      bucket
    })
    console.log('S3 client created successfully')

    const uploadedFiles = []
    
    for (const [key, value] of formData.entries()) {
      console.log(`Processing form field: ${key}`)
      if (value instanceof File) {
        console.log(`Uploading file: ${value.name} (${value.size} bytes)`)
        const fileBuffer = await value.arrayBuffer()
        console.log('File buffer created, uploading to S3...')
        
        const s3File = s3Client.file(value.name)
        await Bun.write(s3File, new Uint8Array(fileBuffer))
        console.log(`File ${value.name} uploaded successfully`)
        
        uploadedFiles.push({
          filename: value.name,
          size: value.size,
          type: value.type
        })
      }
    }

    if (uploadedFiles.length === 0) {
      return c.json({ error: 'No files uploaded' }, 400)
    }

    return c.json({ 
      message: 'Files uploaded successfully',
      files: uploadedFiles
    })

  } catch (error) {
    console.error('Upload error details:', error)
    console.error('Error stack:', error.stack)
    return c.json({ 
      error: 'Upload failed', 
      details: error.message,
      type: error.constructor.name 
    }, 500)
  }
})

app.get('/', (c) => {
  console.log('GET / request received')
  return c.json({ 
    message: 'S3/R2 File Upload Service',
    endpoint: 'POST /upload',
    required_headers: ['Authorization'],
    required_form_data: ['accessKeyId', 'secretAccessKey', 'endpoint', 'bucket', 'files...']
  })
})


export default {
  port: 3000,
  // Allow large uploads (e.g., up to 1 GB) instead of Bun's default 16 MB limit
  maxRequestBodySize: 1024 * 1024 * 1024, // 1 GB
  fetch: app.fetch,
  error(error) {
    console.error('Server error:', error)
    return new Response('Internal Server Error', { status: 500 })
  }
}