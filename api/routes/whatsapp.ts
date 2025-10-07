import { Router } from 'express';
import { client, isClientReady, waitForClient, reinitializeClient } from '../../source/client';
import { getCurrentContacts } from './contacts';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import Whatsapp from 'whatsapp-web.js';

const router = Router();

// In-memory storage for campaigns
let campaigns: any[] = [];
let campaignIdCounter = 1;

// Set up message status update handler
(global as any).onMessageStatusUpdate = (messageId: string, status: string, message: any) => {
  try {
    const messageMap = (global as any).messageRecipientMap;
    if (!messageMap || !messageMap.has(messageId)) {
      return; // Message not tracked
    }
    
    const messageInfo = messageMap.get(messageId);
    const campaign = campaigns.find(c => c.id === messageInfo.campaignId);
    
    if (!campaign || !campaign.recipients) {
      return;
    }
    
    // Find and update the recipient
    const recipient = campaign.recipients.find((r: any) => 
      r.phone === messageInfo.recipientPhone || r.name === messageInfo.recipientName
    );
    
    if (recipient) {
      const oldStatus = recipient.status;
      recipient.status = status;
      recipient.timestamp = new Date().toISOString();
      
      console.log(`📱 Updated ${recipient.name} (${recipient.phone}) status: ${oldStatus} → ${status}`);
      
      // Update campaign updated timestamp
      campaign.updatedAt = new Date().toISOString();
      
      // Emit real-time update to WebSocket clients
      const io = (global as any).io;
      if (io) {
        io.emit('campaign-update', {
          campaignId: campaign.id,
          campaign: campaign
        });
      }
    }
  } catch (error) {
    console.error('Error updating message status:', error);
  }
};

// Multer setup for image upload (in-memory)
const storage = multer.memoryStorage();
const imageUpload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed (jpg, png, gif, webp)'));
    }
  },
  limits: { fileSize: 16 * 1024 * 1024 }
});

// WhatsApp status endpoint
router.get('/status', async (req, res) => {
  try {
    if (!client) {
      return res.json({ 
        status: 'disconnected', 
        authenticated: false,
        message: 'WhatsApp client not initialized' 
      });
    }

    // Check global status first to avoid calling getState when client isn't ready
    const globalStatus = (global as any).whatsappStatus || 'initializing';
    const globalAuth = (global as any).whatsappAuthenticated || false;

    // Handle special states
    if (globalStatus === 'logging_out') {
      return res.json({
        status: 'logging_out',
        authenticated: false,
        state: 'logging_out',
        message: 'Logging out of WhatsApp...'
      });
    }

    if (globalStatus === 'error' || globalStatus === 'failed') {
      return res.json({
        status: 'error',
        authenticated: false,
        state: globalStatus,
        message: 'WhatsApp client error - please refresh'
      });
    }

    // Only try to get state if we think the client might be ready
    if (globalStatus === 'ready' || globalStatus === 'authenticated') {
      try {
        const state = await client.getState();
        const isAuthenticated = state === 'CONNECTED';
        
        return res.json({
          status: isAuthenticated ? 'authenticated' : (state === 'OPENING' ? 'qr_ready' : 'disconnected'),
          authenticated: isAuthenticated,
          state: state
        });
      } catch (stateError) {
        // Fall back to global status if getState fails
        console.warn('getState failed, using global status:', stateError);
      }
    }

    // Use global status as fallback
    res.json({
      status: globalStatus,
      authenticated: globalAuth,
      state: globalStatus
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.json({ 
      status: 'disconnected', 
      authenticated: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// WhatsApp QR code endpoint
router.get('/qr', async (req, res) => {
  try {
    if (!client) {
      return res.status(500).json({ 
        error: 'WhatsApp client not initialized',
        qrCode: null,
        status: 'disconnected'
      });
    }

    // Check global status and QR first
    const globalStatus = (global as any).whatsappStatus || 'initializing';
    const globalQR = (global as any).whatsappQR;
    const globalAuth = (global as any).whatsappAuthenticated || false;

    // If already authenticated, don't try to get state
    if (globalAuth || globalStatus === 'ready' || globalStatus === 'authenticated') {
      return res.json({
        qrCode: null,
        status: 'authenticated',
        message: 'Already authenticated'
      });
    }

    // If we have a QR code available, return it
    if (globalQR) {
      return res.json({
        qrCode: globalQR,
        status: 'qr_ready',
        message: 'Scan QR code to authenticate'
      });
    }

    // Only try getState if we think it's safe
    if (globalStatus === 'ready' || globalStatus === 'authenticated') {
      try {
        const state = await client.getState();
        
        if (state === 'CONNECTED') {
          return res.json({
            qrCode: null,
            status: 'authenticated',
            message: 'Already authenticated'
          });
        }
      } catch (stateError) {
        console.warn('getState failed in QR endpoint:', stateError);
      }
    }

    // Return current status
    res.json({
      qrCode: globalQR,
      status: globalStatus,
      message: globalStatus === 'qr_ready' ? 'Scan QR code to authenticate' : 'Waiting for QR code...'
    });
  } catch (error) {
    console.error('QR generation error:', error);
    res.status(500).json({ 
      error: 'Failed to generate QR code',
      details: error instanceof Error ? error.message : 'Unknown error',
      qrCode: null,
      status: 'error'
    });
  }
});

// Start broadcast campaign - REAL IMPLEMENTATION
router.post('/broadcast', imageUpload.single('image'), async (req, res) => {
  try {
    const { message, campaignName, filters } = req.body;
    // If image is present, process and save it
    let imageInfo = null;
    if (req.file) {
      const uploadPath = path.join(__dirname, '../../uploads/');
      if (!fs.existsSync(uploadPath)) {
        fs.mkdirSync(uploadPath, { recursive: true });
      }
      const originalName = req.file.originalname;
      const ext = path.extname(originalName).toLowerCase();
      const baseName = path.basename(originalName, ext);
      const timestamp = Date.now();
      let outExt = ext;
      let outMime = req.file.mimetype;
      let outBuffer = req.file.buffer;
      // Compress if file is > 1MB or not already webp/jpeg
      if (req.file.size > 1024 * 1024 || !['.jpg', '.jpeg', '.webp'].includes(ext)) {
        outExt = '.webp';
        outMime = 'image/webp';
        outBuffer = await sharp(req.file.buffer)
          .webp({ quality: 80 })
          .toBuffer();
      }
      const outFileName = `${timestamp}-${baseName}${outExt}`;
      const outFilePath = path.join(uploadPath, outFileName);
      fs.writeFileSync(outFilePath, outBuffer);
      imageInfo = {
        filePath: outFilePath,
        mimeType: outMime,
        fileName: outFileName
      };
    }
    if (!message || !campaignName) {
      return res.status(400).json({ 
        error: 'Missing required fields: message and campaignName' 
      });
    }
    if (!(await isClientReady())) {
      return res.status(400).json({ 
        error: 'WhatsApp client is not ready. Please ensure WhatsApp is connected and authenticated.' 
      });
    }
    const allContacts = getCurrentContacts();
    let targetContacts = allContacts;
    if (filters && Object.keys(filters).length > 0) {
      targetContacts = allContacts.filter(contact => {
        return Object.entries(filters).every(([fieldName, filterValue]) => {
          if (!filterValue || String(filterValue).trim() === '') {
            return true;
          }
          const contactValue = contact[fieldName];
          if (!contactValue) {
            return false;
          }
          return String(contactValue).toLowerCase().includes(String(filterValue).toLowerCase());
        });
      });
    }
    if (targetContacts.length === 0) {
      return res.status(400).json({ 
        error: 'No contacts found matching the specified filters' 
      });
    }
    const campaignId = `campaign_${campaignIdCounter++}`;
    const campaign = {
      id: campaignId,
      name: campaignName,
      message: message,
      image: imageInfo ? imageInfo.fileName : null,
      targets: targetContacts.length,
      status: 'running',
      progress: { sent: 0, failed: 0, total: targetContacts.length, errors: [] },
      recipients: targetContacts.map(contact => ({
        name: contact.name || 'Unknown',
        phone: contact.phone || '',
        email: contact.email || '',
        status: 'pending',
        timestamp: null,
        error: null,
        messageId: null
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    campaigns.push(campaign);
    // Start REAL message sending process
    processRealBroadcast(campaignId, message, targetContacts, imageInfo);
    res.json({
      success: true,
      campaignId: campaignId,
      targets: targetContacts.length,
      message: `Campaign "${campaignName}" started successfully`
    });
  } catch (error) {
    console.error('Broadcast error:', error);
    res.status(500).json({ 
      error: 'Failed to start broadcast campaign',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// REAL message sending function
async function processRealBroadcast(campaignId: string, message: string, contacts: any[], imageInfo?: { filePath: string, mimeType: string, fileName: string } | null) {
  const campaign = campaigns.find(c => c.id === campaignId);
  if (!campaign) {
    console.error('Campaign not found:', campaignId);
    return;
  }
  console.log(`🚀 Starting REAL broadcast for campaign ${campaignId} with ${contacts.length} contacts`);
  try {
    if (!(await isClientReady())) {
      console.log('⏳ WhatsApp client not ready, waiting...');
      await waitForClient(60000);
    }
    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      
      // Find the recipient in the campaign
      const recipient = campaign.recipients?.find(r => 
        r.phone === contact.phone || r.name === contact.name
      );
      
      try {
        let cleanPhone = contact.phone?.toString().replace(/\D/g, "");
        if (!cleanPhone || cleanPhone.length === 0) {
          campaign.progress.failed++;
          campaign.progress.errors.push(`No phone number for ${contact.name}`);
          if (recipient) {
            recipient.status = 'failed';
            recipient.error = 'No phone number provided';
            recipient.timestamp = new Date().toISOString();
          }
          console.log(`❌ No phone number for ${contact.name}`);
          continue;
        }
        if (cleanPhone.length === 10) {
          cleanPhone = "91" + cleanPhone;
        }
        if (cleanPhone.length < 12 || cleanPhone.length > 15) {
          campaign.progress.failed++;
          campaign.progress.errors.push(`Invalid phone number for ${contact.name}: ${contact.phone}`);
          if (recipient) {
            recipient.status = 'failed';
            recipient.error = `Invalid phone number: ${contact.phone}`;
            recipient.timestamp = new Date().toISOString();
          }
          console.log(`❌ Invalid phone number for ${contact.name}: ${contact.phone}`);
          continue;
        }
        // Check if number is registered on WhatsApp
        const numberId = await client.getNumberId(cleanPhone);
        
        if (!numberId || !numberId._serialized) {
          campaign.progress.failed++;
          campaign.progress.errors.push(`${contact.name}'s number (${contact.phone}) is not registered on WhatsApp`);
          if (recipient) {
            recipient.status = 'failed';
            recipient.error = 'Number not registered on WhatsApp';
            recipient.timestamp = new Date().toISOString();
          }
          console.log(`❌ ${contact.name} (${cleanPhone}) is not on WhatsApp`);
          continue;
        }
        
        const chatId = numberId._serialized;
        const personalizedMessage = message
          .replace(/\{\{name\}\}/g, contact.name || 'there')
          .replace(/\{\{role\}\}/g, contact.assignedRole || contact.role || 'participant')
          .replace(/\{\{project\}\}/g, contact.project || 'N/A')
          .replace(/\{\{branch\}\}/g, contact.branch || 'N/A')
          .replace(/\{\{year\}\}/g, contact.year || 'N/A')
          .replace(/\{\{email\}\}/g, contact.email || 'N/A');
        if (!(await isClientReady())) {
          throw new Error('WhatsApp client disconnected during broadcast');
        }
        console.log(`📱 Sending to ${contact.name} (${cleanPhone})...`);
        
        // SEND THE ACTUAL MESSAGE (with or without image)
        let messageResponse;
        if (imageInfo) {
          const imageData = fs.readFileSync(imageInfo.filePath, { encoding: 'base64' });
          const media = new Whatsapp.MessageMedia(imageInfo.mimeType, imageData, imageInfo.fileName);
          messageResponse = await client.sendMessage(chatId, media, { caption: personalizedMessage });
        } else {
          messageResponse = await client.sendMessage(chatId, personalizedMessage);
        }
        
        campaign.progress.sent++;
        campaign.updatedAt = new Date().toISOString();
        
        // Update recipient status and store message ID
        if (recipient) {
          recipient.status = 'sent';
          recipient.timestamp = new Date().toISOString();
          recipient.error = null;
          recipient.messageId = messageResponse.id._serialized;
          
          // Store mapping for status updates
          (global as any).messageRecipientMap = (global as any).messageRecipientMap || new Map();
          (global as any).messageRecipientMap.set(messageResponse.id._serialized, {
            campaignId,
            recipientPhone: contact.phone,
            recipientName: contact.name
          });
        }
        console.log(`✅ Message sent to ${contact.name} (${cleanPhone})`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (error) {
        campaign.progress.failed++;
        campaign.progress.errors.push(`Failed to send to ${contact.name}: ${error}`);
        
        // Update recipient status on failure
        if (recipient) {
          recipient.status = 'failed';
          recipient.error = error instanceof Error ? error.message : 'Unknown error';
          recipient.timestamp = new Date().toISOString();
        }
        
        console.error(`❌ Failed to send message to ${contact.name}:`, error);
      }
    }
    campaign.status = 'completed';
    campaign.updatedAt = new Date().toISOString();
    console.log(`🎉 Campaign ${campaignId} completed: ${campaign.progress.sent} sent, ${campaign.progress.failed} failed`);
  } catch (error) {
    campaign.status = 'failed';
    campaign.updatedAt = new Date().toISOString();
    console.error('❌ Real broadcast error:', error);
  }
}

// Get campaigns
router.get('/campaigns', (req, res) => {
  res.json({
    success: true,
    data: campaigns.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  });
});

// Get specific campaign
router.get('/campaigns/:id', (req, res) => {
  const campaign = campaigns.find(c => c.id === req.params.id);
  
  if (!campaign) {
    return res.status(404).json({ error: 'Campaign not found' });
  }
  
  res.json({ success: true, data: campaign });
});

// WhatsApp logout endpoint
router.post('/logout', async (req, res) => {
  try {
    if (!client) {
      return res.json({ 
        success: false, 
        message: 'WhatsApp client not initialized' 
      });
    }

    console.log('🚪 WhatsApp logout requested via routes');
    
    // Reset global status first
    (global as any).whatsappStatus = 'logging_out';
    (global as any).whatsappAuthenticated = false;
    (global as any).whatsappQR = null;
    
    // Logout the client
    await client.logout();
    
    // Update status after logout
    (global as any).whatsappStatus = 'disconnected';
    
    console.log('✅ WhatsApp logout successful - will reinitialize for new QR');
    
    // Send response immediately
    res.json({
      success: true,
      message: 'Successfully logged out from WhatsApp. New QR code will be generated shortly.'
    });
    
    // Reinitialize after a delay using safe method (don't await this)
    setTimeout(async () => {
      try {
        (global as any).whatsappStatus = 'initializing';
        await reinitializeClient();
        console.log('✅ WhatsApp client reinitialized successfully');
      } catch (reinitError) {
        console.error('❌ Failed to reinitialize WhatsApp client:', reinitError);
        (global as any).whatsappStatus = 'error';
        
        // Try one more time after a longer delay
        setTimeout(async () => {
          try {
            console.log('🔄 Retry reinitializing WhatsApp client...');
            (global as any).whatsappStatus = 'initializing';
            await reinitializeClient();
            console.log('✅ WhatsApp client reinitialized on retry');
          } catch (retryError) {
            console.error('❌ Final reinitialize attempt failed:', retryError);
            (global as any).whatsappStatus = 'failed';
          }
        }, 10000);
      }
    }, 5000);
    
  } catch (error) {
    console.error('❌ Logout error:', error);
    
    // Reset status even on error
    (global as any).whatsappStatus = 'disconnected';
    (global as any).whatsappAuthenticated = false;
    (global as any).whatsappQR = null;
    
    res.status(500).json({ 
      success: false,
      error: 'Failed to logout',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Export campaigns for other modules
export const getCampaigns = () => campaigns;
export const getCampaign = (id: string) => campaigns.find(c => c.id === id);

export default router; 