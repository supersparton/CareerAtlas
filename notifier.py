import os
import requests
from dotenv import load_dotenv

load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

def send_job_alert(job, score, reason):
    """
    Sends a beautifully formatted Telegram notification to your phone.
    """
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    
    # Format message with markdown for nice bolding and layout
    message = (
        f"🎯 *NEW JOB MATCH FOUND!* ({score}/100)\n"
        f"━━━━━━━━━━━━━━━━━━━\n"
        f"💼 *Title:* {job.get('title')}\n"
        f"📍 *Location:* {job.get('location') or 'Not specified'}\n"
        f"🔗 *URL:* {job.get('url') or 'N/A'}\n\n"
        f"💡 *LLM Reason:* {reason}\n"
        f"━━━━━━━━━━━━━━━━━━━\n"
        f"🛠️ *Short Summary:* {job.get('requirements') or 'No summary available.'}"
    )
    
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "Markdown"
    }
    
    try:
        response = requests.post(url, json=payload)
        if response.status_code == 200:
            print(f"📲 Telegram alert sent for '{job.get('title')}'!")
            return True
        else:
            print(f"❌ Telegram API Error: {response.text}")
            return False
    except Exception as e:
        print(f"❌ Telegram Connection Error: {e}")
        return False

if __name__ == "__main__":
    # Test alert
    test_job = {
        "title": "Agentic AI Developer",
        "location": "San Francisco / Remote",
        "url": "https://careers.openai.com",
        "requirements": "Build stateful multi-agent systems and orchestrate reasoning workflows using Python and LlamaIndex."
    }
    
    print("Sending test notification...")
    send_job_alert(test_job, 98, "Highly aligned with your core focus on agentic AI workflows and Python stack.")
