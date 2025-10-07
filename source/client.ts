import Whatsapp, {
    type Chat,
    type Client as ClientType,
    type Message,
} from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
const { Client, LocalAuth } = Whatsapp;

const client = new Client({
    puppeteer: {
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--no-first-run",
            "--no-zygote",
            "--disable-gpu"
        ],
    },
    authStrategy: new LocalAuth({
        dataPath: '.wwebjs_auth'
    })
});

// Initialize global status
(global as any).whatsappStatus = 'initializing';
(global as any).whatsappAuthenticated = false;
(global as any).whatsappQR = null;

export const WA = {
    Buttons: Whatsapp.Buttons,
    List: Whatsapp.List,
};

export type ChatOptions = {
    quote?: Message;
    message: Message;
    chat: Chat;
    client: ClientType;
};

// Add connection state tracking
let isReady = false;
let isConnecting = false;
let isInitialized = false;

client.on("auth_failure", (msg) => {
    console.error("AUTHENTICATION FAILURE", msg);
    (global as any).whatsappStatus = 'auth_failure';
    isReady = false;
});

client.on("authenticated", async () => {
    console.log("AUTHENTICATED");
    console.log("⏳ Waiting for WhatsApp Web to finish loading...");
    (global as any).whatsappQR = null;
    (global as any).whatsappStatus = 'authenticated';
    (global as any).whatsappAuthenticated = true;
    
    // Workaround: Aggressively poll to check if client is ready
    // The "ready" event often doesn't fire in whatsapp-web.js v1.26.0
    let attempts = 0;
    const maxAttempts = 30; // Try for 30 seconds
    
    const checkReady = setInterval(async () => {
        if (isReady) {
            clearInterval(checkReady);
            return;
        }
        
        attempts++;
        try {
            // Try to get client info - if this works, client is ready
            const info = await client.info;
            if (info && info.wid) {
                console.log("📱 Client detected as ready (manual check after " + attempts + " attempts)");
                console.log("CLIENT IS READY");
                console.log("📱 Connected as:", info.pushname);
                isReady = true;
                isConnecting = false;
                isInitialized = true;
                (global as any).whatsappStatus = 'ready';
                clearInterval(checkReady);
            }
        } catch (error) {
            // Client not ready yet, keep trying
            if (attempts >= maxAttempts) {
                console.log("⚠️ Client ready check timed out after 30 seconds. Please try restarting.");
                clearInterval(checkReady);
            } else if (attempts % 5 === 0) {
                console.log(`⏳ Still waiting for client to be ready... (attempt ${attempts}/${maxAttempts})`);
            }
        }
    }, 1000); // Check every second
});

client.on("ready", () => {
    console.log("CLIENT IS READY");
    isReady = true;
    isConnecting = false;
    isInitialized = true;
    (global as any).whatsappStatus = 'ready';
    (global as any).whatsappAuthenticated = true;
});

// Add loading_screen event to detect when client is initializing
client.on("loading_screen", (percent, message) => {
    console.log(`📱 Loading WhatsApp Web: ${percent}% - ${message}`);
    (global as any).whatsappStatus = 'loading';
});

client.on("qr", (qr) => {
    qrcode.generate(qr, { small: true });
    // Store QR code for API access
    (global as any).whatsappQR = qr;
    (global as any).whatsappStatus = 'qr_ready';
    (global as any).whatsappAuthenticated = false;
    isReady = false;
    console.log('📱 QR Code available at: http://localhost:5000/api/whatsapp/qr');
});

client.on("disconnected", (reason) => {
    console.log("Client was logged out, reason:", reason);
    (global as any).whatsappQR = null;
    (global as any).whatsappStatus = 'disconnected';
    (global as any).whatsappAuthenticated = false;
    isReady = false;
    isConnecting = false; // Reset connecting state
    
    // Only auto-reconnect if it wasn't a manual logout
    if (reason !== 'LOGOUT') {
        console.log("Auto-reconnecting due to unexpected disconnection...");
        setTimeout(() => {
            if (!isConnecting && isInitialized) {
                console.log("Attempting to reconnect...");
                isConnecting = true;
                client.initialize();
            }
        }, 5000);
    } else {
        console.log("Manual logout detected - disconnection complete");
        // Reset initialization state for manual logout
        isInitialized = false;
    }
});

// Message status tracking for delivery and read receipts
client.on('message_ack', (msg: any, ack: any) => {
    try {
        // ack values:
        // 0 = ACK_ERROR (not sent)
        // 1 = ACK_PENDING (clock icon - message sent)
        // 2 = ACK_SERVER (single check - message received by WhatsApp servers)
        // 3 = ACK_DEVICE (double check - message delivered to recipient's device)
        // 4 = ACK_READ (double blue check - message read by recipient)
        
        const messageId = msg.id._serialized;
        const status = ack === 4 ? 'read' : ack === 3 ? 'delivered' : ack === 2 ? 'sent' : 'pending';
        
        console.log(`📩 Message ${messageId} status updated to: ${status} (ack: ${ack})`);
        
        // Emit status update to update campaigns
        (global as any).messageStatusUpdates = (global as any).messageStatusUpdates || new Map();
        (global as any).messageStatusUpdates.set(messageId, {
            status,
            timestamp: new Date().toISOString(),
            ack
        });
        
        // Trigger a status update event that the campaign system can listen to
        if (typeof (global as any).onMessageStatusUpdate === 'function') {
            (global as any).onMessageStatusUpdate(messageId, status, msg);
        }
        
    } catch (error) {
        console.error('Error handling message status update:', error);
    }
});

// Export helper functions
export const isClientReady = async () => {
    // ONLY return true if the ready event has fired
    // The CONNECTED state alone is not enough - we need the full client ready
    return isReady;
};

// Synchronous version for cases where we can't use async
export const isClientReadySync = () => isReady;

export const isClientInitialized = () => isInitialized;
export const waitForClient = async (timeout = 30000) => {
    return new Promise(async (resolve, reject) => {
        if (await isClientReady()) {
            resolve(true);
            return;
        }
        
        const startTime = Date.now();
        const checkInterval = setInterval(async () => {
            if (await isClientReady()) {
                clearInterval(checkInterval);
                resolve(true);
            } else if (Date.now() - startTime > timeout) {
                clearInterval(checkInterval);
                reject(new Error('WhatsApp client not ready within timeout'));
            }
        }, 1000);
    });
};

// Safe reinitialize function
export const reinitializeClient = async () => {
    if (isConnecting) {
        console.log('⚠️ Client already connecting, skipping reinitialize');
        return;
    }
    
    try {
        isConnecting = true;
        console.log('🔄 Safely reinitializing WhatsApp client...');
        
        // Wait a bit if client was just disconnected
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        await client.initialize();
        console.log('✅ Client reinitialized successfully');
    } catch (error) {
        console.error('❌ Client reinitialize failed:', error);
        isConnecting = false;
        throw error;
    }
};

export { client };
