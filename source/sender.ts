import { MessageMedia } from 'whatsapp-web.js';
import path from 'path';
import fs from 'fs';

interface Contact {
  name: string;
  phone: string;
}
export async function sendDocumentToContacts({
  client,
  fileName,
  contacts,
  delay = 3000,
}: {
  client: any;
  fileName: string;
  contacts: Contact[];
  delay?: number;
}) {

  const filePath = path.join(__dirname, '..', 'api', 'uploads', 'documents', fileName);

  console.log('📁 Trying to send file from:', filePath);
  

  if (!fs.existsSync(filePath)) {
    console.error('❌ File not found:', filePath);
    throw new Error('File does not exist. Please check upload location.');
  }

  const media = MessageMedia.fromFilePath(filePath);

  for (const contact of contacts) {
    let cleanPhone = contact.phone?.toString().replace(/\D/g, '');
    if (!cleanPhone) {
      console.warn(`⚠️ Skipping ${contact.name} - no valid phone`);
      continue;
    }

    if (cleanPhone.length === 10) {
      cleanPhone = '91' + cleanPhone;
    }

    if (cleanPhone.length < 12 || cleanPhone.length > 15) {
      console.warn(`⚠️ Invalid phone for ${contact.name}: ${cleanPhone}`);
      continue;
    }

    try {
      // Check if number is registered on WhatsApp
      const numberId = await client.getNumberId(cleanPhone);
      
      if (!numberId || !numberId._serialized) {
        console.warn(`⚠️ ${contact.name} (${cleanPhone}) is not registered on WhatsApp - skipping`);
        continue;
      }
      
      const chatId = numberId._serialized;
      
      await client.sendMessage(chatId, media);
      console.log(`✅ Sent document to ${contact.name} (${cleanPhone})`);
      await new Promise((res) => setTimeout(res, delay));
    } catch (err: any) {
      console.error(`❌ Failed to send to ${contact.name}:`, err.message);
    }
  }
  fs.unlink(filePath, (err) => {
      if (err) {
        console.error('🧹 Failed to delete file:', err.message);
      } else {
        console.log('🧼 Deleted file after broadcast:', filePath);
      }
    });
}
