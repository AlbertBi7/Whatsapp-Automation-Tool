import { client } from "../source/client";

// REAL DATA: Using production data
import JsonData from "@/script/certificates/out.json";

import { simplifiedDataZod, type CertificateZod } from "./validation";
// import { MessageMedia } from "whatsapp-web.js";
import { getInternMessage } from "./message";

const json = simplifiedDataZod.parse(JsonData);

// SEND TO EVERYONE - No filtering by role
const filteredJson = json; // Everyone gets a message now

const id = "gamejam";
const imageFolder = `./script/certificates/${id}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

client.once("ready", () => {
    console.log("Client is ready! Preparing data from JSON");
    console.log(`🚀 PRODUCTION MODE - Using real data`);
    console.log(`Total entries in JSON: ${json.length}`);
    console.log(`📨 SENDING TO EVERYONE - ${filteredJson.length} messages will be sent`);
    
    // Count by role in original data
    const roleCount = json.reduce((acc, entry) => {
        const role = entry.assignedRole || 'unknown';
        acc[role] = (acc[role] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);
    
    console.log("Breakdown by role (all data):", roleCount);
    console.log("🎯 Sending the INTERN message template to ALL users");
    console.log("⏱️  Using 5-second delay between messages for safer delivery");

    let messagesSent = 0;
    let messagesSkipped = 0;

    filteredJson.forEach((data, i) => {
        const { name, email, phone, assignedRole } = data;
        
        // Use the intern message template for everyone
        const messageText = getInternMessage(data);
        
        setTimeout(async () => {
            try {
                // Clean phone number - ensure it's in correct format
                let cleanPhone = phone?.toString().replace(/\D/g, ""); // Remove non-digits
                
                if (!cleanPhone || cleanPhone.length === 0) {
                    console.log(`${i + 1}. ⚠️  No phone number for ${name} (${email}) - Skipping WhatsApp`);
                    messagesSkipped++;
                    return;
                }
                
                // Add country code if not present (assuming India +91)
                if (cleanPhone.length === 10) {
                    cleanPhone = "91" + cleanPhone;
                }
                
                // Validate phone number length
                if (cleanPhone.length < 12 || cleanPhone.length > 15) {
                    console.log(`${i + 1}. ⚠️  Invalid phone number format for ${name} (${phone}) - Skipping WhatsApp`);
                    messagesSkipped++;
                    return;
                }
                
                // Check if number is registered on WhatsApp
                const numberId = await client.getNumberId(cleanPhone);
                
                if (!numberId || !numberId._serialized) {
                    console.log(`${i + 1}. ⚠️  ${name} (${cleanPhone}) is not registered on WhatsApp - Skipping`);
                    messagesSkipped++;
                    return;
                }
                
                const chatId = numberId._serialized;
                
                console.log(`${i + 1}. Sending to ${name} - ${cleanPhone} (${assignedRole || 'unknown'})...`);
                
                await client.sendMessage(chatId, messageText);
                console.log(`${i + 1}. ✅ Sent WhatsApp to ${name} - ${cleanPhone}`);
                messagesSent++;
                
            } catch (error) {
                console.log(`${i + 1}. ❌ Error sending WhatsApp to ${name} (${phone}):`, error);
                messagesSkipped++;
            }
        }, i * 5000); // 5 second delay between messages for safer delivery
    });
    
    // Final summary after all messages are scheduled
    setTimeout(() => {
        console.log(`\n📊 SUMMARY:`);
        console.log(`Total entries processed: ${filteredJson.length}`);
        console.log(`Messages sent: ${messagesSent}`);
        console.log(`Messages skipped: ${messagesSkipped}`);
    }, (filteredJson.length + 1) * 5000);
});

client.initialize();
