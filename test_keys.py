import os
import requests
from dotenv import load_dotenv

# Load keys from the .env file
load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

def test_telegram():
    print("Testing Telegram...")
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": "🤖 Hello! I am your CareerOS Agent. My API keys are working!"
    }
    response = requests.post(url, json=payload)
    if response.status_code == 200:
        print("✅ Telegram: Success! Check your phone for a message.")
    else:
        print(f"❌ Telegram Error: {response.text}")

def test_groq():
    print("Testing Groq (using llama3-8b-8192)...")
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {os.getenv('GROQ_API_KEY')}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "llama-3.3-70b-versatile",
        "messages": [{"role": "user", "content": "Say 'Groq connection successful' and nothing else."}]
    }
    response = requests.post(url, headers=headers, json=payload)
    if response.status_code == 200:
        reply = response.json()["choices"][0]["message"]["content"]
        print(f"✅ Groq: Success! LLM says: '{reply.strip()}'")
    else:
        print(f"❌ Groq Error: {response.status_code} - {response.text}")

if __name__ == "__main__":
    print("--- Starting API Key Tests ---\n")
    if not GROQ_API_KEY or not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("❌ Error: Missing keys in .env file. Please make sure you renamed .env.example to .env and filled it out.")
    else:
        test_telegram()
        print("")
        test_groq()
        print("\n--- Tests Complete ---")
