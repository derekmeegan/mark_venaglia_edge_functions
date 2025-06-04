// send-email.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
serve(async (req)=>{
  // Handle preflight OPTIONS request
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    });
  }
  try {
    const { name, email, subject, message } = await req.json();
    const sendgridResponse = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${Deno.env.get("SENDGRID_API_KEY")}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [
              {
                email: "markvenaglia@gmail.com"
              }
            ],
            subject: subject || "New Contact Form Message"
          }
        ],
        from: {
          email: "automations@derekmeegan.com"
        },
        content: [
          {
            type: "text/plain",
            value: `Name: ${name}\nEmail: ${email}\n\nMessage: ${message}`
          }
        ]
      })
    });
    if (!sendgridResponse.ok) {
      const errorText = await sendgridResponse.text();
      return new Response(errorText, {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }
    return new Response("Email sent successfully", {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    });
  } catch (error) {
    return new Response("Internal server error", {
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    });
  }
});
