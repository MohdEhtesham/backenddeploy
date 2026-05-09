const { z } = require('zod');

const phoneRegex = /^[6-9]\d{9}$/;

const signupSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  phone: z.string().regex(phoneRegex, 'Invalid Indian mobile'),
  password: z.string().min(6),
  role: z.enum(['consumer', 'seller']).optional(),
});

const loginSchema = z.object({
  identifier: z.string().min(3),
  password: z.string().min(6),
  role: z.enum(['consumer', 'seller']).optional(),
});

const otpRequestSchema = z.object({
  phone: z.string().regex(phoneRegex, 'Invalid Indian mobile'),
});

const otpVerifySchema = z.object({
  phone: z.string().regex(phoneRegex),
  otp: z.string().length(4),
  role: z.enum(['consumer', 'seller']).optional(),
});

const forgotSchema = z.object({
  identifier: z.string().min(3),
});

module.exports = {
  signupSchema,
  loginSchema,
  otpRequestSchema,
  otpVerifySchema,
  forgotSchema,
};
