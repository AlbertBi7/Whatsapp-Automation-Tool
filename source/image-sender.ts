import { client } from './client';
import Whatsapp from 'whatsapp-web.js';
import fs from 'fs';
import path from 'path';

/**
 * Send an image to a WhatsApp number using the bot.
 * @param phoneNumber - The recipient's phone number (with country code, e.g. 919876543210)
 * @param imagePath - The absolute or relative path to the image file
 * @param caption - Optional caption for the image
 */
export async function sendImageToWhatsApp(phoneNumber: string, imagePath: string, caption?: string): Promise<void> {
  // Clean phone number and format for WhatsApp
  let cleanPhone = phoneNumber.replace(/\D/g, '');
  if (cleanPhone.length === 10) {
    cleanPhone = '91' + cleanPhone; // Default to India if only 10 digits
  }
  
  // Check if number is registered on WhatsApp
  const numberId = await client.getNumberId(cleanPhone);
  
  if (!numberId || !numberId._serialized) {
    throw new Error(`Phone number ${cleanPhone} is not registered on WhatsApp`);
  }
  
  const chatId = numberId._serialized;

  // Read image file and create MessageMedia
  const resolvedPath = path.resolve(imagePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Image file not found: ${resolvedPath}`);
  }
  const mimeType = getMimeType(resolvedPath);
  const imageData = fs.readFileSync(resolvedPath, { encoding: 'base64' });
  const media = new Whatsapp.MessageMedia(mimeType, imageData, path.basename(resolvedPath));

  // Send the image
  await client.sendMessage(chatId, media, { caption });
}

// Helper to get mime type from file extension
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
} 