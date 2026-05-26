import json
import time
from dotenv import load_dotenv

# Import our custom modules
from discovery import fetch_page_with_tinyfish, extract_jobs_with_llm, load_seen_jobs, save_seen_jobs, generate_job_hash
from classifier import score_job_match, USER_PROFILE
from notifier import send_job_alert

load_dotenv()

# The main active job board we are scanning in V1
JOB_BOARDS = [
    "https://news.ycombinator.com/jobs"
]

def run_agentic_pipeline():
    print("\n🚀 === Starting Hermes Agent Run === 🚀")
    
    # 1. Load the history of jobs we've already dealt with
    seen_hashes = load_seen_jobs()
    print(f"📂 Loaded {len(seen_hashes)} seen jobs from memory.")
    
    new_jobs_found = []
    
    # 2. Iterate through all targets and scrape
    for board_url in JOB_BOARDS:
        scraped_text = fetch_page_with_tinyfish(board_url)
        if not scraped_text:
            continue
            
        jobs = extract_jobs_with_llm(scraped_text)
        print(f"🧐 LLM extracted {len(jobs)} total jobs from {board_url}.")
        
        # Filter duplicates immediately so we don't spend API tokens scoring them
        for job in jobs:
            job_hash = generate_job_hash(job)
            if job_hash not in seen_hashes:
                new_jobs_found.append((job, job_hash))
                
    print(f"\n🔍 Deduplication complete. Found {len(new_jobs_found)} NEW jobs to evaluate.")
    
    if not new_jobs_found:
        print("😴 No new jobs to score. Sleeping until next run.")
        return
        
    # 3. Score and Filter each new job
    matched_count = 0
    
    for job, job_hash in new_jobs_found:
        # Avoid getting rate limited by Groq on large sweeps by adding a tiny delay
        time.sleep(0.5) 
        
        # Skip garbage extractions (e.g. if the LLM parsed a null title)
        if not job.get("title"):
            print(f"⏭️ Skipping invalid job entry: {job}")
            # Mark it as seen so we don't try to parse it again
            seen_hashes.append(job_hash)
            continue
            
        evaluation = score_job_match(job, USER_PROFILE)
        score = evaluation.get("score", 0)
        reason = evaluation.get("reason", "No reason provided.")
        
        print(f"📈 Job Match: '{job.get('title')}' -> Score: {score}/100")
        
        # 4. Trigger alert if fit matches our threshold (70+)
        if score >= 70:
            print(f"🔥 EXCELLENT FIT DETECTED! Sending Telegram Alert...")
            alert_success = send_job_alert(job, score, reason)
            if alert_success:
                matched_count += 1
        else:
            print("💤 Fit score below threshold. No alert sent.")
            
        # Mark as seen so we never process/score this job again
        seen_hashes.append(job_hash)
        
    # 5. Save all updated hashes back to memory
    save_seen_jobs(seen_hashes)
    
    print("\n🏁 === Hermes Agent Run Complete ===")
    print(f"📊 Summary: Scored {len(new_jobs_found)} new jobs | Matched and sent {matched_count} alerts.\n")

if __name__ == "__main__":
    run_agentic_pipeline()
