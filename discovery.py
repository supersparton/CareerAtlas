import os
import json
import hashlib
import requests
from dotenv import load_dotenv

load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
TINYFISH_API_KEY = os.getenv("TINYFISH_API_KEY")

SEEN_JOBS_FILE = "seen_jobs.json"

def fetch_page_with_tinyfish(url):
    """
    Uses TinyFish to scrape a careers page and return clean markdown text.
    """
    print(f"🐟 Fetching {url} with TinyFish...")
    api_url = "https://api.fetch.tinyfish.ai" 
    headers = {
        "X-API-Key": TINYFISH_API_KEY,
        "Content-Type": "application/json"
    }
    payload = {"urls": [url]}
    
    try:
        response = requests.post(api_url, headers=headers, json=payload)
        if response.status_code == 200:
            data = response.json()
            try:
                # Extract ONLY the clean text from the results array
                page_text = data["results"][0]["text"]
                return page_text
            except (KeyError, IndexError):
                print("❌ Unexpected TinyFish JSON structure.")
                return None
        else:
            print(f"❌ TinyFish Error: {response.text}")
            return None
    except Exception as e:
        print(f"❌ Connection error: {e}")
        return None

def extract_jobs_with_llm(page_text):
    """
    Feeds the scraped text to the LLM and forces it to return a structured JSON list of jobs.
    """
    print("🧠 Asking LLM to extract jobs...")
    
    prompt = f"""
    You are an AI career agent. I am giving you the text of a company's career page.
    Extract EVERY job posting you can find in this text.
    
    Return ONLY a valid JSON array of objects. 
    Do NOT include conversational text. Do NOT include markdown code blocks like ```json.
    
    Each object must have these exact keys: 
    "title", "location", "url" (if available), "requirements" (short summary)

    Here is the scraped career page text:
    ---
    {page_text[:25000]} 
    ---
    """

    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "llama-3.3-70b-versatile",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1 # Keep it low for consistent JSON
    }
    
    response = requests.post(url, headers=headers, json=payload)
    if response.status_code == 200:
        content = response.json()["choices"][0]["message"]["content"].strip()
        try:
            jobs = json.loads(content)
            return jobs
        except json.JSONDecodeError:
            print("❌ LLM did not return valid JSON!")
            print("Raw LLM Output:\n", content)
            return []
    else:
        print(f"❌ OpenRouter Error: {response.status_code} - {response.text}")
        return []

# --- DEDUPLICATION LOGIC ---

def generate_job_hash(job):
    """
    Generates a unique SHA-256 fingerprint for a job based on its title, location, and url.
    """
    unique_string = f"{job.get('title', '')}|{job.get('location', '')}|{job.get('url', '')}"
    # Convert string to bytes and generate hash
    return hashlib.sha256(unique_string.encode('utf-8')).hexdigest()

def load_seen_jobs():
    """
    Loads list of previously seen job hashes from the local JSON file.
    """
    if os.path.exists(SEEN_JOBS_FILE):
        try:
            with open(SEEN_JOBS_FILE, "r") as f:
                return json.load(f)
        except json.JSONDecodeError:
            return []
    return []

def save_seen_jobs(seen_hashes):
    """
    Saves the list of seen job hashes back to the local JSON file.
    """
    with open(SEEN_JOBS_FILE, "w") as f:
        json.dump(seen_hashes, f, indent=2)

if __name__ == "__main__":
    test_url = "https://news.ycombinator.com/jobs" 
    
    # 1. Fetch the raw page
    scraped_text = fetch_page_with_tinyfish(test_url)
    
    if scraped_text:
        # 2. Extract jobs via LLM
        all_jobs = extract_jobs_with_llm(scraped_text)
        
        # 3. Load previously seen job hashes
        seen_hashes = load_seen_jobs()
        print(f"\n📂 Loaded {len(seen_hashes)} seen jobs from memory.")
        
        new_jobs = []
        skipped_count = 0
        
        # 4. Filter out duplicates
        for job in all_jobs:
            job_hash = generate_job_hash(job)
            if job_hash in seen_hashes:
                skipped_count += 1
            else:
                new_jobs.append(job)
                seen_hashes.append(job_hash) # Mark as seen
        
        # 5. Save the updated list of seen hashes
        save_seen_jobs(seen_hashes)
        
        # 6. Report results
        print(f"⏭️ Skipped {skipped_count} already-seen jobs.")
        print(f"🔥 Found {len(new_jobs)} NEW jobs!")
        
        if new_jobs:
            print("\nClean list of NEW jobs:")
            print(json.dumps(new_jobs, indent=2))
