import swaggerJsdoc  from 'swagger-jsdoc';
import swaggerUiExpress from 'swagger-ui-express';
import { Application } from 'express';
import { env }          from './env';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title:       'Healthcare Appointment Booking API',
      version:     '4.0.0',
      description: 'Production-ready API for healthcare appointment booking with OPD queue management, real-time notifications, and search.',
      contact:     { name: 'Engineering', email: 'engineering@upcharify.com' },
    },
    servers: [
      { url: `http://localhost:${env.PORT}/api/v1`, description: 'Development' },
    ],
    components: {
      securitySchemes: {
        BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        SuccessResponse: {
          type: 'object',
          properties: {
            success:    { type: 'boolean', example: true },
            data:       { type: 'object' },
            request_id: { type: 'string', format: 'uuid' },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code:    { type: 'string', example: 'VALIDATION_ERROR' },
                message: { type: 'string', example: 'Enter a valid mobile number' },
              },
            },
            request_id: { type: 'string', format: 'uuid' },
          },
        },
        PaginationMeta: {
          type: 'object',
          properties: {
            total:       { type: 'integer' },
            page:        { type: 'integer' },
            per_page:    { type: 'integer' },
            total_pages: { type: 'integer' },
          },
        },
        // Auth
        RequestOtpRequest: {
          type: 'object', required: ['mobile'],
          properties: {
            mobile:       { type: 'string', example: '9876543210' },
            country_code: { type: 'string', example: '+91', default: '+91' },
          },
        },
        VerifyOtpRequest: {
          type: 'object', required: ['mobile', 'otp'],
          properties: {
            mobile: { type: 'string', example: '9876543210' },
            otp:    { type: 'string', example: '482910', minLength: 6, maxLength: 6 },
          },
        },
        TokenPair: {
          type: 'object',
          properties: {
            access_token:  { type: 'string' },
            refresh_token: { type: 'string' },
            expires_in:    { type: 'integer', example: 900 },
          },
        },
        // Appointments
        BookAppointmentRequest: {
          type: 'object', required: ['doctor_id', 'hospital_id', 'slot_id'],
          properties: {
            doctor_id:        { type: 'string', format: 'uuid' },
            hospital_id:      { type: 'string', format: 'uuid' },
            slot_id:          { type: 'string', format: 'uuid' },
            notes:            { type: 'string', maxLength: 500 },
            appointment_type: { type: 'string', enum: ['online_booking', 'walk_in', 'follow_up'] },
          },
        },
        // Profile
        CompleteProfileRequest: {
          type: 'object', required: ['full_name', 'date_of_birth', 'gender'],
          properties: {
            full_name:     { type: 'string', example: 'Kishor Patil' },
            date_of_birth: { type: 'string', format: 'date', example: '1992-06-15' },
            gender:        { type: 'string', enum: ['male', 'female', 'other', 'prefer_not_to_say'] },
            email:         { type: 'string', format: 'email' },
            blood_group:   { type: 'string', enum: ['A+','A-','B+','B-','AB+','AB-','O+','O-'] },
          },
        },
      },
      responses: {
        Unauthorized: {
          description: 'Missing or invalid access token',
          content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } },
        },
        Forbidden: {
          description: 'Insufficient permissions or incomplete profile',
          content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } },
        },
        NotFound: {
          description: 'Resource not found',
          content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } },
        },
        ValidationError: {
          description: 'Request body validation failed',
          content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } },
        },
        TooManyRequests: {
          description: 'Rate limit exceeded',
          content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } },
        },
      },
    },
    tags: [
      { name: 'Health',         description: 'Server health checks' },
      { name: 'Auth',           description: 'OTP authentication and token management' },
      { name: 'Patients',       description: 'Patient profile management' },
      { name: 'Hospitals',      description: 'Hospital registration and management' },
      { name: 'Doctors',        description: 'Doctor profiles and verification' },
      { name: 'Schedules',      description: 'Weekly schedules and slot generation' },
      { name: 'Appointments',   description: 'Booking, cancellation, and history' },
      { name: 'Payments',       description: 'Razorpay payment processing' },
      { name: 'Queue',          description: 'Real-time consultation queue' },
      { name: 'Receptionist',   description: 'Front-desk operations' },
      { name: 'Notifications',  description: 'Notification preferences and history' },
      { name: 'OPD',            description: 'High-volume token-based OPD sessions' },
      { name: 'Search',         description: 'Doctor search and discovery' },
      { name: 'Admin',          description: 'Platform administration and analytics' },
    ],
  },
  // Path patterns where JSDoc annotations live
  apis: ['./src/modules/**/*.routes.ts', './src/routes/index.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);

export function setupSwagger(app: Application): void {
  // Only mount Swagger in non-production (or set SWAGGER_ENABLED=true for prod)
  if (env.NODE_ENV === 'production' && !process.env.SWAGGER_ENABLED) return;

  app.use('/api/docs', swaggerUiExpress.serve, swaggerUiExpress.setup(swaggerSpec, {
    customSiteTitle: 'Healthcare API Docs',
    swaggerOptions: { persistAuthorization: true },
  }));

  // Raw spec endpoint for import into Postman/Insomnia
  app.get('/api/docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });

  console.log(`📚  Swagger UI: http://localhost:${env.PORT}/api/docs`);
}
