import os
import json
import requests
from dotenv import load_dotenv

load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY")

# This is YOUR target profile (you can change this to match your real resume and goals!)
def load_profile():
    profile_path = "profile.txt"
    if os.path.exists(profile_path):
        with open(profile_path, "r", encoding="utf-8") as f:
            return f.read()
    return """
Target Role: Backend Software Engineer or AI/Agent Developer.
Core Skills: Python, FastAPI, Django, PostgreSQL, LLM integration, basic JavaScript, and building AI agent workflows.
Experience Level: Junior to Mid-level (willing to look at internships up to 2-3 years experience).
Preferences: Prefers remote roles or roles in active tech hubs. Not interested in non-technical sales, marketing, or senior manager positions.
"""

USER_PROFILE = load_profile()

def score_job_match(job, profile):
    """
    Uses Groq LLM to semantically grade how well a job fits the user's profile on a scale of 0-100.
    """
    print(f"🤖 Scoring job: '{job.get('title')}'...")
    
    prompt = f"""
    You are an expert technical recruiter matching jobs to an engineer's profile.
    
    Here is the ENGINEER'S TARGET PROFILE:
    ---
    {profile}
    ---
    
    Here is the JOB POSTING to evaluate:
    ---
    Title: {job.get('title')}
    Location: {job.get('location')}
    Requirements/Summary: {job.get('requirements')}
    ---
    
    Grade this match on a scale of 0 to 100:
    - 0-30: Terrible fit (sales, marketing, unrelated tech stack like C++ or iOS, or too senior)
    - 31-69: Moderate fit (general tech roles, partial skill alignment, or missing major preferences)
    - 70-100: Excellent fit (strong skill match in Python/AI/FastAPI, right experience level)
    
    Return ONLY a valid JSON object. Do NOT write conversational text. Do NOT wrap in ```json.
    Your JSON must have these exact keys:
    "score": (integer from 0 to 100),
    "reason": "A 1-sentence explanation of why you gave this score based on skill alignment."
    """

    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "llama-3.3-70b-versatile",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.0 # Strict and deterministic
    }
    
    try:
        response = requests.post(url, headers=headers, json=payload)
        if response.status_code == 200:
            content = response.json()["choices"][0]["message"]["content"].strip()
            # Convert JSON response back to a Python dictionary
            return json.loads(content)
        else:
            print(f"❌ Groq Error in Scoring: {response.text}")
            return {"score": 0, "reason": "Failed to connect to LLM scorer."}
    except Exception as e:
        print(f"❌ Error during scoring: {e}")
        return {"score": 0, "reason": "Exception raised during scoring."}

if __name__ == "__main__":
    # Let's test it with two very different mock jobs to see if the AI can tell them apart!
    
    good_job_mock = {
        "title": "Backend Python Developer (FastAPI)",
        "location": "Remote",
        "requirements": "Build backend microservices using Python, FastAPI, and PostgreSQL. Help integrate OpenAI APIs for agentic automation."
    }
    
    bad_job_mock = {
        "title": "Senior Sales Development Representative",
        "location": "New York",
        "requirements": "Cold call prospects, manage pipeline, sales experience required. No coding involved."
    }
    
    print("--- Starting Classifier Test ---\n")
    
    # Test 1: The Good Fit
    good_result = score_job_match(good_job_mock, USER_PROFILE)
    print(f"Result Good Job: Score={good_result.get('score')} | Reason: {good_result.get('reason')}\n")
    
    # Test 2: The Bad Fit
    bad_result = score_job_match(bad_job_mock, USER_PROFILE)
    print(f"Result Bad Job: Score={bad_result.get('score')} | Reason: {bad_result.get('reason')}\n")
