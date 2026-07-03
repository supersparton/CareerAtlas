# Career Agent – Official Company Career Watcher

## Goal

Build a reliable job monitoring system that watches **official company career pages** and notifies users whenever a new matching job is posted.

The system should:

* Search only official company career websites.
* Behave like a real user using a browser.
* Avoid duplicate alerts.
* Minimize browser launches.
* Reuse discovered career search pages.
* Automatically recover from failures.
* Scale to thousands of users.

---

# High-Level Architecture

```text
                Users
                   │
                   ▼
            Career Agent API
                   │
                   ▼
              PostgreSQL
                   │
        Saved Search Preferences
                   │
                   ▼
          Scheduler (Cron Jobs)
                   │
                   ▼
      Browser Search Service
   (Playwright + Stealth/Camoufox)
                   │
                   ▼
     Official Company Career Pages
                   │
                   ▼
        Normalized Job Results
                   │
                   ▼
        Duplicate Detection
                   │
                   ▼
       Notification Service
      Telegram / Email / Push
```

---

# User Input

Every saved search contains only three fields.

```text
Company Name
Role
Location
```

Example

```text
Company : Google

Role : Software Engineer

Location : Canada
```

Nothing else is required from the user.

---

# First-Time Company Discovery

When a company is searched for the first time, the system performs a **one-time discovery**.

Example:

```text
Google
```

The Browser Search Service behaves exactly like a real user.

Example flow:

```text
google.com

↓

Careers

↓

Google Careers Search Page

↓

Store Career Search URL
```

The purpose of discovery is **only** to find the official page where jobs can be searched.

For example, after discovery we store something like:

```text
https://careers.google.com/jobs/results/
```

or

```text
https://careers.microsoft.com/search
```

This discovery happens only once unless the career page changes.

---

# What We Store

We intentionally keep this very simple.

Example

```text
Company Name

Official Career Search URL

Last Verified Time
```

Example

```text
Company

Google

Career URL

https://careers.google.com/jobs/results/

Verified

2026-07-03
```

---

# What We DO NOT Store

The system never stores or depends on website internals.

We do NOT store:

* Internal REST endpoints
* GraphQL endpoints
* Hidden APIs
* Request payloads
* Authentication tokens
* Cookies
* Internal AJAX requests
* Network traffic
* Website implementation details

The browser always behaves like a real user by interacting with the visible website.

This makes the system much more resilient because website backend implementations may change while the public career page continues to work.

---

# Scheduler

Each company is checked on a fixed schedule.

Example

```text
Every Hour

↓

Google

↓

Microsoft

↓

Amazon

↓

Adobe
```

The scheduler groups searches by company.

Instead of

```text
User A

Launch Browser

Close Browser

User B

Launch Browser

Close Browser

User C

Launch Browser

Close Browser
```

it creates one company batch.

Example

```text
Google

↓

All Google Searches

↓

One Browser
```

---

# Browser Search Service

The Browser Search Service is completely independent from the Career Agent backend.

Its responsibilities are only:

* Launch browser
* Open official career page
* Search jobs
* Extract results
* Normalize results
* Return results

It does NOT:

* Send Telegram notifications
* Send Emails
* Score jobs
* Manage users

It is responsible only for searching.

---

# Browser Lifecycle

For every scheduled company batch:

```text
Launch Browser

↓

Open Stored Career URL

↓

Execute All Searches

↓

Collect Results

↓

Close Browser
```

Only one browser instance is launched per company batch.

---

# Search Flow

Example

Stored Career URL

```text
https://careers.google.com/jobs/results/
```

Users

```text
User A

Software Engineer

Canada
```

```text
User B

Backend Engineer

USA
```

```text
User C

ML Engineer

India
```

Execution

```text
Launch Browser

↓

Open Google Career Page

↓

Search
Software Engineer
Canada

↓

Extract Jobs

↓

Search
Backend Engineer
USA

↓

Extract Jobs

↓

Search
ML Engineer
India

↓

Extract Jobs

↓

Close Browser
```

The browser simply updates the visible search fields between queries.

---

# Browser Behavior

The browser behaves exactly like a normal human visitor.

For every search:

```text
Open Career Search Page

↓

Enter Role

↓

Enter Location

↓

Click Search

↓

Wait For Results

↓

Extract Jobs

↓

Repeat
```

No reverse engineering.

No direct API calls.

No hidden endpoints.

No internal website dependencies.

---

# Browser Configuration

The browser should appear as close to a real browser as possible.

Requirements

* Stealth browser
* Real browser fingerprint
* Realistic User-Agent
* Real viewport
* Proper timezone
* Correct locale
* Correct Accept-Language
* WebGL enabled
* Canvas fingerprint consistency
* Audio fingerprint consistency
* Font fingerprint consistency
* Real browser behavior
* Human-like interaction timing

The goal is to minimize anti-bot detection during scheduled searches.

---

# Normalized Job Object

Every search returns a common format.

```text
Job ID

Company

Role

Location

Employment Type

Remote Status

Posting Date

Job URL

Description

Source
```

---

# Duplicate Detection

Duplicate detection happens per user.

Example

```text
User A

Already Alerted

Google

Software Engineer

Job 123
```

If Job 123 appears again

```text
Skip
```

If Job 124 appears

```text
Queue Notification
```

Each user maintains an independent notification history.

---

# Notification Flow

```text
Search Results

↓

Duplicate Detection

↓

New Job?

↓

Yes

↓

Notification Queue

↓

Telegram

Email

Push
```

The Browser Search Service never sends notifications directly.

---

# Error Recovery

The system must automatically recover from failures.

If a page crashes

```text
Restart Page

↓

Resume Current Search
```

If the browser crashes

```text
Restart Browser

↓

Resume Remaining Searches
```

If navigation times out

```text
Retry

↓

Exponential Backoff

↓

Continue
```

If extraction fails

```text
Capture Screenshot

↓

Log Error

↓

Continue
```

One failure must never stop the remaining searches.

---

# Anti-Bot Handling

The Browser Search Service should detect situations like:

* CAPTCHA
* Cloudflare challenge
* Access denied pages
* Human verification
* Unexpected redirects
* Empty pages caused by bot protection

Recovery strategy

```text
Retry

↓

Fresh Browser Context

↓

Retry

↓

Backoff

↓

Continue Remaining Searches
```

If repeated failures occur, mark the company for manual review while allowing other companies to continue processing.

---

# Logging

Log every important event.

Examples

```text
Browser Started

Company Search Started

Career URL Opened

Role Search Executed

Location Applied

Jobs Found

Retry Count

Browser Restarted

Timeout

Captcha Detected

Notification Queued

Batch Completed
```

---

# Metrics

Track:

* Browser startup time
* Company search duration
* Jobs found
* Duplicate rate
* Notifications queued
* Browser crash count
* CAPTCHA detection count
* Retry count
* Memory usage
* CPU usage
* Success rate
* Failure rate

---

# Scalability

The architecture supports multiple browser workers.

```text
Scheduler

↓

Queue

↓

Worker 1

Worker 2

Worker 3

Worker 4
```

Each worker processes different company batches independently.

Workers can be added or removed without changing the main application.

---

# Design Principles

* Search only official company career pages.
* Discover the official career search page only once.
* Store only the official career search URL.
* Never depend on hidden APIs or internal website endpoints.
* Group searches by company.
* Launch one browser per company batch.
* Reuse the same browser for all searches within that batch.
* Simulate normal user interaction for every search.
* Keep searching and notifications as separate services.
* Deduplicate alerts per user.
* Automatically recover from crashes and timeouts.
* Handle anti-bot systems gracefully.
* Maintain detailed logs and operational metrics.
* Keep the architecture horizontally scalable and fault tolerant.
