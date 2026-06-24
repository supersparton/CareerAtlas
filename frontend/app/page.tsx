"use client";

import React, { useState, useEffect } from "react";

interface ResumeWorkExperience {
  company: string;
  role: string;
  duration: string;
  description: string;
}

interface ResumeProject {
  title: string;
  techStack: string[];
  description: string;
}

interface ParsedProfile {
  fullName: string;
  email: string;
  phone: string;
  targetRole: string;
  coreSkills: string[];
  experienceLevel: string;
  preferences?: {
    locations: string[];
    remote: boolean;
    employmentTypes?: string[];
    salaryExpectation?: number;
  };
  targetLocation: string;
  isRemoteOpen: boolean;
  experience: ResumeWorkExperience[];
  projects: ResumeProject[];
}

interface PipelineStep {
  id: string;
  name: string;
  description: string;
  status: "idle" | "running" | "success" | "error";
  errorDetails?: string;
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState<boolean>(false);
  const [profile, setProfile] = useState<ParsedProfile | null>(null);
  
  // Search state
  const [searchTerms, setSearchTerms] = useState<string[]>([]);
  const [newTermInput, setNewTermInput] = useState<string>("");
  const [locationPref, setLocationPref] = useState<string>("Ahmedabad");
  const [isRemoteOpen, setIsRemoteOpen] = useState<boolean>(true);
  const [employmentTypes, setEmploymentTypes] = useState<string[]>(["Full-time"]);
  
  interface JobResult {
    id: number;
    jobId: string;
    company: string;
    title: string;
    location: string;
    source: string;
    url?: string;
    score: number;
    reasoning: string;
    status: string;
    createdAt: string;
  }

  // Status and logs
  const [logs, setLogs] = useState<string[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState<boolean>(false);
  const [workflowRunning, setWorkflowRunning] = useState<boolean>(false);
  const [results, setResults] = useState<JobResult[]>([]);
  const [loadingResults, setLoadingResults] = useState<boolean>(false);

  // Pipeline Flow steps state
  const [pipelineSteps, setPipelineSteps] = useState<PipelineStep[]>([
    { id: "step-1", name: "1. Profile Sync & User Embedding", description: "Saves structured profile and uploads experience/achievements to user_embeddings", status: "idle" },
    { id: "step-2", name: "2. Scraper Discovery Ingestion", description: "Crawls LinkedIn and queries TinyFish API boards concurrently", status: "idle" },
    { id: "step-3", name: "3. Validation Layer Checks", description: "Filters duplicates, screens expired jobs, and HEAD-pings links", status: "idle" },
    { id: "step-4", name: "4. Structured JD Extraction", description: "Extracts required skills, experience, and remote status via LLM", status: "idle" },
    { id: "step-5", name: "5. Job Embedding & pgvector", description: "Stores job records and 384-dimension vector embeddings in DB", status: "idle" },
    { id: "step-6", name: "6. Multi-Stage Match Engines", description: "Applies Hard Filters, Skill Aliases, and Cosine Vector Similarity", status: "idle" },
    { id: "step-7", name: "7. Weighted Ranking & Telegram Alerts", description: "Combines matching scores and dispatches top alerts to Telegram", status: "idle" },
  ]);

  const [activeTab, setActiveTab] = useState<"search" | "watcher">("search");

  // Watcher states
  const [watchlists, setWatchlists] = useState<any[]>([]);
  const [loadingWatchlists, setLoadingWatchlists] = useState<boolean>(false);
  const [companyName, setCompanyName] = useState("");
  const [companyIdentifier, setCompanyIdentifier] = useState("");
  const [careersUrl, setCareersUrl] = useState("");
  const [desiredRolesStr, setDesiredRolesStr] = useState("");
  const [preferredLocationsStr, setPreferredLocationsStr] = useState("");
  const [keywordsStr, setKeywordsStr] = useState("");
  const [notificationFrequency, setNotificationFrequency] = useState("realtime");

  // Real discovered endpoints feed
  const [discoveredEndpoints, setDiscoveredEndpoints] = useState<{
    requestUrl: string;
    method: string;
    classification?: string;
    confidenceScore?: number;
    companyName: string;
    capturedAt: string;
    saved: boolean;
  }[]>([]);
  const [discovering, setDiscovering] = useState<number | null>(null); // companyId being scanned

  const fetchWatchlist = async (email?: string) => {
    setLoadingWatchlists(true);
    try {
      const activeEmail = email || profile?.email || localStorage.getItem("user_email") || "default-watcher-user@careeratlas.com";
      const res = await fetch(`/api/watcher/watchlist?email=${encodeURIComponent(activeEmail)}`);
      if (res.ok) {
        const data = await res.json();
        setWatchlists(data || []);
      }
    } catch (e: any) {
      addLog(`Error loading watchlist: ${e.message}`);
    } finally {
      setLoadingWatchlists(false);
    }
  };

  const handleAddWatchlist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName || !companyIdentifier || !careersUrl) {
      alert("Please fill in all company registry fields.");
      return;
    }

    const email = profile?.email || localStorage.getItem("user_email") || "default-watcher-user@careeratlas.com";

    try {
      const res = await fetch("/api/watcher/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userEmail: email,
          companyIdentifier: companyIdentifier.toLowerCase().trim(),
          companyName,
          careersUrl,
          desiredRoles: desiredRolesStr.split(",").map(s => s.trim()).filter(Boolean),
          preferredLocations: preferredLocationsStr.split(",").map(s => s.trim()).filter(Boolean),
          keywords: keywordsStr.split(",").map(s => s.trim()).filter(Boolean),
          notificationFrequency
        })
      });

      if (res.ok) {
        addLog(`Successfully added ${companyName} to your watchlist!`);
        setCompanyName("");
        setCompanyIdentifier("");
        setCareersUrl("");
        setDesiredRolesStr("");
        setPreferredLocationsStr("");
        setKeywordsStr("");
        fetchWatchlist(email);
      } else {
        throw new Error(await res.text());
      }
    } catch (e: any) {
      addLog(`Error adding watchlist: ${e.message}`);
    }
  };

  const handleDeleteWatchlist = async (companyId: number) => {
    const email = profile?.email || localStorage.getItem("user_email") || "default-watcher-user@careeratlas.com";
    try {
      const res = await fetch(`/api/watcher/watchlist/${companyId}?email=${encodeURIComponent(email)}`, {
        method: "DELETE"
      });
      if (res.ok) {
        addLog("Company removed from watchlist.");
        fetchWatchlist(email);
      } else {
        throw new Error(await res.text());
      }
    } catch (e: any) {
      addLog(`Error deleting watchlist: ${e.message}`);
    }
  };

  const handleTriggerWatcherCheck = async () => {
    addLog("Triggering global watcher check cycle...");
    try {
      const res = await fetch("/api/watcher/check-now", {
        method: "POST"
      });
      if (res.ok) {
        addLog("Watcher scan initiated successfully in background.");
        setTimeout(() => {
          fetchWatchlist();
        }, 1500);
      } else {
        throw new Error(await res.text());
      }
    } catch (e: any) {
      addLog(`Error running watcher: ${e.message}`);
    }
  };

  // Fetch captured endpoints from backend discovery_metadata table
  const fetchDiscoveredEndpoints = async (companyIdentifier?: string) => {
    try {
      const url = companyIdentifier
        ? `/api/watcher/discovered?companyIdentifier=${encodeURIComponent(companyIdentifier)}`
        : `/api/watcher/discovered`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setDiscoveredEndpoints(data.map((d: any) => ({
          requestUrl: d.request_url,
          method: d.method,
          classification: d.classification,
          confidenceScore: d.confidence_score,
          companyName: d.company_identifier,
          capturedAt: d.created_at,
          saved: d.is_monitored_server_side
        })));
      }
    } catch {}
  };

  // When user installs extension and visits a page, the extension POSTs to /api/watcher/discover.
  // The frontend polls /api/watcher/discovered to show those real captures live.
  useEffect(() => {
    if (activeTab === "watcher") {
      fetchDiscoveredEndpoints();
      const interval = setInterval(fetchDiscoveredEndpoints, 5000); // poll every 5s
      return () => clearInterval(interval);
    }
  }, [activeTab]);



  // Load existing profile on mount if available
  useEffect(() => {
    fetchProfile().then(() => {
      fetchResults();
      fetchWatchlist();
    });
  }, []);

  const addLog = (message: string) => {
    setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${message}`, ...prev]);
  };

  const updateStepStatus = (id: string, status: "idle" | "running" | "success" | "error", errorDetails?: string) => {
    setPipelineSteps(prev => prev.map(step => 
      step.id === id ? { ...step, status, errorDetails } : step
    ));
  };

  const fetchResults = async (email?: string) => {
    setLoadingResults(true);
    try {
      const emailParam = email ? `?email=${encodeURIComponent(email)}` : "";
      const res = await fetch(`/api/agent/results${emailParam}`);
      if (res.ok) {
        const data = await res.json();
        setResults(data || []);
      }
    } catch (e: any) {
      addLog(`Error loading recommendation results: ${e.message}`);
    } finally {
      setLoadingResults(false);
    }
  };

  const handleClearHistory = async () => {
    if (!confirm("Are you sure you want to clear your matched jobs history and reset all caches? This cannot be undone.")) {
      return;
    }
    setLoadingResults(true);
    try {
      const res = await fetch("/api/agent/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: profile?.email }),
      });
      if (res.ok) {
        addLog("Successfully cleared job match history and scraper cache.");
        setResults([]);
      } else {
        const errMsg = await res.text();
        throw new Error(errMsg);
      }
    } catch (e: any) {
      addLog(`Error clearing history: ${e.message}`);
    } finally {
      setLoadingResults(false);
    }
  };

  const fetchProfile = async () => {
    try {
      const email = localStorage.getItem("user_email") || "";
      const emailParam = email ? `?email=${encodeURIComponent(email)}` : "";
      const res = await fetch(`/api/profile${emailParam}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.fullName && data.fullName !== "Default User" && data.fullName !== "No Resume Uploaded") {
          setProfile(data);
          setLocationPref(data.targetLocation || "Ahmedabad");
          setIsRemoteOpen(data.isRemoteOpen ?? true);
          if (data.preferences?.employmentTypes && data.preferences.employmentTypes.length > 0) {
            setEmploymentTypes(data.preferences.employmentTypes);
          }
          addLog("Loaded existing profile from backend cache.");
          fetchSuggestions(data.email);
          fetchResults(data.email);
        }
      }
    } catch (e) {
      // Ignore initial load error if server is not up yet
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      addLog(`Selected file: ${e.target.files[0].name}`);
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setParsing(true);
    addLog("Uploading PDF resume for text extraction...");
    
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/profile/upload-resume", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error(await res.text() || "Failed to upload and parse resume.");
      }

      const uploadRes = await res.json();
      const taskId = uploadRes.taskId;
      addLog(`Resume uploaded successfully. Task ID: ${taskId}. Initiating real-time parsing status stream...`);

      // Open EventSource for SSE updates
      const eventSource = new EventSource(`/api/profile/parse-status/${taskId}`);

      eventSource.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          addLog(`[Parsing progress] ${data.log}`);

          if (data.status === "success") {
            eventSource.close();
            const parsedData: ParsedProfile = data.profile;
            if (parsedData.email) {
              localStorage.setItem("user_email", parsedData.email);
            }
            setProfile(parsedData);
            setLocationPref(parsedData.targetLocation || "Ahmedabad");
            setIsRemoteOpen(parsedData.isRemoteOpen ?? true);
            if (parsedData.preferences?.employmentTypes && parsedData.preferences.employmentTypes.length > 0) {
              setEmploymentTypes(parsedData.preferences.employmentTypes);
            }
            addLog(`Resume parsed successfully for ${parsedData.fullName}!`);
            
            // Auto-fetch suggestions and results after upload completion
            await fetchSuggestions(parsedData.email);
            fetchResults(parsedData.email);
            setParsing(false);
          } else if (data.status === "error") {
            eventSource.close();
            addLog(`Error parsing resume: ${data.errorDetails}`);
            setParsing(false);
          }
        } catch (err: any) {
          eventSource.close();
          addLog(`Error parsing stream event: ${err.message}`);
          setParsing(false);
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
        addLog("EventSource connection to parsing status stream closed or failed.");
        setParsing(false);
      };
    } catch (e: any) {
      addLog(`Error parsing resume: ${e.message}`);
      setParsing(false);
    }
  };

  const fetchSuggestions = async (email?: string) => {
    setLoadingSuggestions(true);
    addLog("Requesting recommended job titles based on your resume stack...");
    try {
      const activeEmail = email || profile?.email;
      const emailParam = activeEmail ? `?email=${encodeURIComponent(activeEmail)}` : "";
      const res = await fetch(`/api/profile/suggest-titles${emailParam}`);
      if (!res.ok) throw new Error("Could not load recommendations.");
      const data = await res.json();
      setSearchTerms(data.searchTerms || []);
      addLog(`Generated ${data.searchTerms?.length || 0} suggested search titles.`);
    } catch (e: any) {
      addLog(`Error loading title recommendations: ${e.message}`);
    } finally {
      setLoadingSuggestions(false);
    }
  };

  const handleAddTerm = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTerm = newTermInput.trim();
    if (cleanTerm) {
      setSearchTerms([cleanTerm]);
      setNewTermInput("");
      addLog(`Set target search title to: "${cleanTerm}"`);
    }
  };

  const handleRemoveTerm = (term: string) => {
    setSearchTerms((prev) => prev.filter((t) => t !== term));
    addLog(`Removed title: "${term}"`);
  };

  const handleTriggerWorkflow = async () => {
    if (searchTerms.length === 0) {
      addLog("Cannot trigger search: No search titles specified.");
      alert("Please add at least one job search title.");
      return;
    }

    setWorkflowRunning(true);
    addLog("Starting CareerAtlas recommendation pipeline...");
    
    // Reset steps
    setPipelineSteps(prev => prev.map(s => ({ ...s, status: "idle", errorDetails: undefined })));

    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchTerms,
          locationPreference: locationPref,
          isRemoteOpen,
          userEmail: profile?.email,
          employmentTypes,
          salaryExpectation: null,
        }),
      });

      if (!res.ok) {
        const errMsg = await res.text() || "Failed to start scraping suite.";
        throw new Error(errMsg);
      }

      const result = await res.json();
      addLog(`Backend Response: ${result.message}`);
      addLog("Starting real-time execution tracking polling...");

      // Start polling backend status endpoint
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch("/api/agent/status");
          if (statusRes.ok) {
            const backendStatus = await statusRes.json();
            
            // Sync step statuses
            setPipelineSteps(prev => prev.map(step => {
              const backendStep = backendStatus.steps[step.id];
              if (backendStep) {
                return {
                  ...step,
                  status: backendStep.status,
                  errorDetails: backendStep.errorDetails
                };
              }
              return step;
            }));

            // Sync logs
            if (backendStatus.logs && backendStatus.logs.length > 0) {
              setLogs(backendStatus.logs);
            }

            // If backend is no longer active, stop polling
            if (!backendStatus.active) {
              clearInterval(pollInterval);
              setWorkflowRunning(false);
              addLog("Real-time pipeline run completed.");
              fetchResults(profile?.email);
            }
          }
        } catch (pollErr: any) {
          // Ignore polling errors
        }
      }, 1000);

    } catch (e: any) {
      addLog(`Pipeline Aborted: ${e.message}`);
      setPipelineSteps(prev => prev.map(s => 
        s.status === "running" ? { ...s, status: "error", errorDetails: e.message } : s
      ));
      setWorkflowRunning(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500 selection:text-black">
      {/* Background Gradient */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-zinc-900/70 via-zinc-950 to-zinc-950 -z-10 pointer-events-none" />

      <div className="max-w-6xl mx-auto px-6 py-12">
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-6 pb-8 border-b border-zinc-800/80 mb-12">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-xs font-semibold tracking-wider text-emerald-400 uppercase">CareerOS v1 Core</span>
            </div>
            <h1 className="text-4xl font-extrabold tracking-tight text-white bg-clip-text bg-gradient-to-r from-white via-zinc-100 to-zinc-400">
              Autonomous Ingestion & Search
            </h1>
            <p className="text-sm text-zinc-400 mt-1">
              Parse your PDF resume, verify LLM recommendations, and launch the hardened parallel crawler pipeline.
            </p>
          </div>
          <div className="flex items-center gap-3">
          </div>
        </header>
        {/* Tab Switcher */}
        <div className="flex border-b border-zinc-800 mb-10 gap-2">
          <button
            onClick={() => setActiveTab("search")}
            className={`py-3 px-6 text-sm font-semibold border-b-2 transition-all flex items-center gap-2 ${
              activeTab === "search"
                ? "border-emerald-500 text-emerald-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            🔍 Autonomous Search Pipeline
          </button>
          <button
            onClick={() => setActiveTab("watcher")}
            className={`py-3 px-6 text-sm font-semibold border-b-2 transition-all flex items-center gap-2 ${
              activeTab === "watcher"
                ? "border-emerald-500 text-emerald-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            🏢 Dream Company Watcher
          </button>
        </div>

        {activeTab === "search" ? (
          <>
            {/* Dashboard Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Column - Steps & Config */}
          <div className="lg:col-span-7 flex flex-col gap-8">
            
            {/* Step 1: Upload Resume */}
            <section className="bg-zinc-900/40 backdrop-blur-md rounded-2xl border border-zinc-850 p-6 shadow-xl relative overflow-hidden group">
              <div className="absolute top-0 left-0 w-1 h-full bg-emerald-500/50 group-hover:bg-emerald-400 transition-colors" />
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-zinc-800 text-xs text-zinc-300">1</span>
                  Resume Ingestion
                </h2>
                {profile && (
                  <span className="text-xs bg-emerald-950/40 border border-emerald-800/50 text-emerald-400 px-2.5 py-0.5 rounded-full font-medium">
                    Profile Loaded
                  </span>
                )}
              </div>

              <div className="flex flex-col md:flex-row gap-4 items-stretch md:items-center">
                <label className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-zinc-800 rounded-xl py-6 px-4 hover:border-zinc-700 transition-colors cursor-pointer bg-zinc-950/20">
                  <svg className="w-8 h-8 text-zinc-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span className="text-sm text-zinc-300 font-medium text-center">
                    {file ? file.name : "Select Resume PDF"}
                  </span>
                  <span className="text-xs text-zinc-500 mt-1">PDF format only</span>
                  <input
                    type="file"
                    accept=".pdf"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                </label>
                
                <button
                  onClick={handleUpload}
                  disabled={!file || parsing}
                  className="bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-500 text-black font-semibold text-sm px-6 py-4 rounded-xl transition-all shadow-lg shadow-emerald-500/10 active:scale-95 flex items-center justify-center gap-2"
                >
                  {parsing ? (
                    <>
                      <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                      Parsing via LLM...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                      Extract & Parse
                    </>
                  )}
                </button>
              </div>
            </section>

            {/* Step 2: Search Title & Preference Setup */}
            <section className="bg-zinc-900/40 backdrop-blur-md rounded-2xl border border-zinc-850 p-6 shadow-xl relative overflow-hidden group">
              <div className="absolute top-0 left-0 w-1 h-full bg-emerald-500/50 group-hover:bg-emerald-400 transition-colors" />
              <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-6">
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-zinc-800 text-xs text-zinc-300">2</span>
                Search Parameters Configuration
              </h2>

              <div className="flex flex-col gap-5">
                {/* Location Settings */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                      Target Search Location (City/Country)
                    </label>
                    <input
                      type="text"
                      value={locationPref}
                      onChange={(e) => setLocationPref(e.target.value)}
                      placeholder="e.g. Ahmedabad, Bangalore, Remote"
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50 transition-colors"
                    />
                  </div>
                  <div className="flex items-center justify-between bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 mt-0 md:mt-6">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-zinc-200">Include Remote Listings</span>
                      <span className="text-xs text-zinc-500">Expands queries with "OR Remote"</span>
                    </div>
                    <button
                      onClick={() => setIsRemoteOpen(!isRemoteOpen)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        isRemoteOpen ? "bg-emerald-500" : "bg-zinc-800"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          isRemoteOpen ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Employment Preference */}
                <div className="bg-zinc-950/20 border border-zinc-900 rounded-xl p-4">
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                    Employment Type Preference
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {["Full-time", "Part-time", "Contract", "Internship"].map((type) => {
                      const isSelected = employmentTypes.includes(type);
                      return (
                        <button
                          key={type}
                          type="button"
                          onClick={() => {
                            if (isSelected) {
                              if (employmentTypes.length > 1) {
                                setEmploymentTypes(employmentTypes.filter(t => t !== type));
                              }
                            } else {
                              setEmploymentTypes([...employmentTypes, type]);
                            }
                          }}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            isSelected
                              ? "bg-emerald-500/15 border-emerald-500 text-emerald-400"
                              : "bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                          }`}
                        >
                          {type}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Search Term Tags */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                      Target Job Search Title
                    </label>
                    {profile && (
                      <button
                        onClick={() => fetchSuggestions(profile?.email)}
                        disabled={loadingSuggestions}
                        className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors flex items-center gap-1 disabled:opacity-50"
                      >
                        <svg className={`w-3 h-3 ${loadingSuggestions ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 8H18" />
                        </svg>
                        Regenerate Suggestions
                      </button>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2 p-3 min-h-[48px] bg-zinc-950 rounded-xl border border-zinc-800 mb-3">
                    {searchTerms.length === 0 ? (
                      <span className="text-sm text-zinc-600 self-center">No search title set. Parse resume or enter manually below.</span>
                    ) : (
                      searchTerms.map((term) => (
                        <span
                          key={term}
                          className="flex items-center gap-1.5 bg-emerald-950/40 border border-emerald-800/30 text-emerald-300 px-3 py-1 rounded-full text-xs font-medium"
                        >
                          {term}
                          <button
                            onClick={() => handleRemoveTerm(term)}
                            className="hover:text-red-400 transition-colors"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </span>
                      ))
                    )}
                  </div>

                  <form onSubmit={handleAddTerm} className="flex gap-2">
                    <input
                      type="text"
                      value={newTermInput}
                      onChange={(e) => setNewTermInput(e.target.value)}
                      placeholder="Enter new job title (will overwrite current)"
                      className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50 transition-colors"
                    />
                    <button
                      type="submit"
                      className="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-semibold text-sm px-4 rounded-xl transition-all"
                    >
                      Set Title
                    </button>
                  </form>
                </div>
              </div>
            </section>

            {/* Step 3: Trigger Pipeline */}
            <section className="bg-zinc-900/40 backdrop-blur-md rounded-2xl border border-zinc-850 p-6 shadow-xl relative overflow-hidden group">
              <div className="absolute top-0 left-0 w-1 h-full bg-emerald-500/50 group-hover:bg-emerald-400 transition-colors" />
              <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-zinc-800 text-xs text-zinc-300">3</span>
                Execute Search Loop
              </h2>
              <p className="text-xs text-zinc-400 mb-6">
                Launching the workflow triggers LinkedIn browser-crawling and API queries for Instahyre, Greenhouse, Lever, YC, etc. matches are evaluated and alerts sent to Telegram.
              </p>

              <button
                onClick={handleTriggerWorkflow}
                disabled={workflowRunning || searchTerms.length === 0}
                className="w-full bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 disabled:from-zinc-800 disabled:to-zinc-850 disabled:text-zinc-500 text-black font-extrabold text-sm py-4 rounded-xl transition-all shadow-lg shadow-emerald-500/15 active:scale-[0.98] flex items-center justify-center gap-2"
              >
                {workflowRunning ? (
                  <>
                    <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                    Launching Scraping Pipeline...
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Start Autonomous Job Search
                  </>
                )}
              </button>
            </section>

          </div>

          {/* Right Column - Profile Preview & Logs */}
          <div className="lg:col-span-5 flex flex-col gap-8">
            
            {/* Live Terminal / Logs */}
            <section className="bg-black/60 rounded-2xl border border-zinc-850 p-6 shadow-xl flex flex-col h-[280px]">
              <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Pipeline Activity Console
              </h3>
              <div className="flex-1 overflow-y-auto font-mono text-[11px] text-zinc-400 bg-zinc-950/60 p-4 rounded-xl border border-zinc-900 flex flex-col-reverse gap-1.5">
                {logs.length === 0 ? (
                  <span className="text-zinc-600">Console idle. Ready for resume ingestion...</span>
                ) : (
                  logs.map((log, idx) => (
                    <div key={idx} className="whitespace-pre-wrap leading-relaxed">
                      {log}
                    </div>
                  ))
                )}
              </div>
            </section>
 
            {/* Pipeline Architecture Timeline Visualizer */}
            <section className="bg-zinc-900/40 backdrop-blur-md rounded-2xl border border-zinc-850 p-6 shadow-xl flex flex-col">
              <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-4 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-teal-400" />
                Pipeline Flow Architecture Timeline
              </h3>
              <div className="flex flex-col gap-4">
                {pipelineSteps.map((step, idx) => {
                  let statusColor = "bg-zinc-850 border-zinc-800";
                  let statusDot = "bg-zinc-700";
                  let textColor = "text-zinc-500";
                  let descColor = "text-zinc-600";
                  let showSpinner = false;

                  if (step.status === "running") {
                    statusColor = "bg-yellow-950/40 border-yellow-500/50";
                    statusDot = "bg-yellow-400 animate-pulse";
                    textColor = "text-yellow-200 font-semibold";
                    descColor = "text-yellow-400/80";
                    showSpinner = true;
                  } else if (step.status === "success") {
                    statusColor = "bg-emerald-950/40 border-emerald-500/50";
                    statusDot = "bg-emerald-400";
                    textColor = "text-emerald-300 font-semibold";
                    descColor = "text-zinc-400";
                  } else if (step.status === "error") {
                    statusColor = "bg-red-950/40 border-red-500/50";
                    statusDot = "bg-red-500 animate-ping";
                    textColor = "text-red-300 font-bold";
                    descColor = "text-red-400";
                  }

                  return (
                    <div key={step.id} className="relative flex gap-4 items-start">
                      {/* Vertical line connector */}
                      {idx < pipelineSteps.length - 1 && (
                        <div className="absolute left-3 top-6 bottom-0 w-0.5 bg-zinc-800" />
                      )}
                      
                      {/* Dot Indicator */}
                      <div className={`z-10 flex items-center justify-center w-6.5 h-6.5 rounded-full border ${statusColor} bg-zinc-950 shrink-0 p-1`}>
                        {step.status === "success" ? (
                          <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                        ) : step.status === "error" ? (
                          <svg className="w-3.5 h-3.5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                          </svg>
                        ) : showSpinner ? (
                          <div className="w-3.5 h-3.5 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <div className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
                        )}
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className={`text-xs ${textColor} transition-colors flex items-center justify-between`}>
                          <span>{step.name}</span>
                          {step.status === "error" && (
                            <span className="text-[10px] bg-red-950/60 border border-red-800/50 text-red-400 px-2 py-0.5 rounded-full font-mono uppercase tracking-wider">
                              Failed
                            </span>
                          )}
                        </div>
                        <div className={`text-[10px] ${descColor} mt-0.5 transition-colors`}>
                          {step.description}
                        </div>
                        {step.status === "error" && step.errorDetails && (
                          <div className="mt-1.5 p-2 bg-red-950/20 border border-red-900/30 rounded-lg text-[10px] font-mono text-red-400 break-all leading-normal">
                            Reason: {step.errorDetails}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Profile Info Preview */}
            <section className="bg-zinc-900/20 backdrop-blur-md rounded-2xl border border-zinc-850 p-6 shadow-xl flex-1 flex flex-col">
              <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-4">
                Parsed Profile Metadata Summary
              </h3>

              {profile ? (
                <div className="flex-1 overflow-y-auto flex flex-col gap-4 text-sm text-zinc-300">
                  <div className="border-b border-zinc-850 pb-3">
                    <div className="text-xs text-zinc-500">Full Name</div>
                    <div className="font-semibold text-white">{profile.fullName || "N/A"}</div>
                    <div className="text-xs text-zinc-400 mt-1">{profile.email} • {profile.phone}</div>
                  </div>

                  <div>
                    <div className="text-xs text-zinc-500 mb-1.5">Core Technical Stack</div>
                    <div className="flex flex-wrap gap-1">
                      {profile.coreSkills?.map((skill) => (
                        <span key={skill} className="bg-zinc-850 text-zinc-300 text-xs px-2.5 py-0.5 rounded">
                          {skill}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs text-zinc-500">Target Role Preference</div>
                    <div className="text-white font-medium">{profile.targetRole}</div>
                  </div>

                  <div>
                    <div className="text-xs text-zinc-500">Experience Seniority</div>
                    <div className="text-white font-medium">{profile.experienceLevel}</div>
                  </div>

                  {profile.experience?.length > 0 && (
                    <div>
                      <div className="text-xs text-zinc-500 mb-2">Recent Experience</div>
                      <div className="flex flex-col gap-2.5">
                        {profile.experience.slice(0, 2).map((exp, idx) => (
                          <div key={idx} className="bg-zinc-900/40 p-2.5 rounded-lg border border-zinc-850">
                            <div className="font-semibold text-xs text-white">{exp.role}</div>
                            <div className="text-[11px] text-zinc-400">{exp.company} • {exp.duration}</div>
                            <div className="text-[11px] text-zinc-500 line-clamp-2 mt-1">{exp.description}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-6 border border-dashed border-zinc-850 rounded-xl bg-zinc-950/10">
                  <svg className="w-12 h-12 text-zinc-700 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  <span className="text-sm text-zinc-500">No profile parsed yet. Please upload a PDF resume in Step 1.</span>
                </div>
              )}
            </section>

          </div>
        </div>

        {/* Results Section */}
        <section className="mt-12 pt-12 border-t border-zinc-800/80">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse" />
                Job Recommendation Results
              </h2>
              <p className="text-xs text-zinc-400 mt-1">
                Real-time recommendations from vector similarities, rank-weighted algorithms, and customized profile matches.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleClearHistory}
                disabled={loadingResults || workflowRunning}
                className="text-xs bg-red-950/20 hover:bg-red-900/30 text-red-400 border border-red-900/50 hover:border-red-800 px-4 py-2.5 rounded-xl transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Clear History & Cache
              </button>
              <button
                onClick={() => fetchResults(profile?.email)}
                disabled={loadingResults}
                className="text-xs bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 px-4 py-2.5 rounded-xl transition-all flex items-center gap-2 disabled:opacity-50"
              >
                <svg className={`w-3.5 h-3.5 ${loadingResults ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 8H18" />
                </svg>
                Refresh Results
              </button>
            </div>
          </div>

          {loadingResults ? (
            <div className="flex flex-col items-center justify-center py-20 border border-dashed border-zinc-800 rounded-2xl bg-zinc-950/20">
              <div className="w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mb-3" />
              <span className="text-sm text-zinc-500">Querying database results table...</span>
            </div>
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 border border-dashed border-zinc-800 rounded-2xl bg-zinc-950/20 text-center">
              <svg className="w-12 h-12 text-zinc-800 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm text-zinc-500 font-medium">No recommendation results found in database.</span>
              <span className="text-xs text-zinc-650 mt-1 max-w-sm">
                Run the autonomous search pipeline above to scrape listings, score them, and populate recommendations.
              </span>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {results.map((item) => {
                let scoreColor = "bg-zinc-805 text-zinc-400";
                if (item.score >= 90) {
                  scoreColor = "bg-emerald-500/10 border-emerald-500/30 text-emerald-400";
                } else if (item.score >= 75) {
                  scoreColor = "bg-teal-500/10 border-teal-500/30 text-teal-400";
                } else if (item.score >= 50) {
                  scoreColor = "bg-yellow-500/10 border-yellow-500/30 text-yellow-400";
                }

                return (
                  <div key={item.id} className="bg-zinc-900/30 backdrop-blur-md rounded-2xl border border-zinc-850 p-6 flex flex-col justify-between hover:border-zinc-700 transition-colors shadow-lg group">
                    <div>
                      <div className="flex items-start justify-between gap-4 mb-3">
                        <div className="min-w-0">
                          <h3 className="text-base font-bold text-white truncate group-hover:text-emerald-400 transition-colors">
                            {item.title}
                          </h3>
                          <p className="text-sm font-semibold text-zinc-400 truncate mt-0.5">
                            {item.company}
                          </p>
                        </div>
                        <div className={`shrink-0 px-3 py-1.5 rounded-xl border text-xs font-extrabold font-mono flex items-center justify-center gap-1 ${scoreColor}`}>
                          <span>{item.score}%</span>
                          <span className="text-[10px] opacity-70">Match</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-500 border-b border-zinc-850/50 pb-3 mb-4">
                        <span className="flex items-center gap-1">
                          <svg className="w-3.5 h-3.5 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                          {item.location}
                        </span>
                        <span className="flex items-center gap-1">
                          <svg className="w-3.5 h-3.5 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                          </svg>
                          {item.source}
                        </span>
                        <span className="flex items-center gap-1">
                          <svg className="w-3.5 h-3.5 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          {new Date(item.createdAt).toLocaleDateString()}
                        </span>
                      </div>

                      {item.reasoning && (
                        <div>
                          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">AI Recommendation Reasoning</span>
                          <p className="bg-zinc-950/40 border border-zinc-900 rounded-xl p-3.5 text-xs text-zinc-350 mt-1 italic leading-relaxed">
                            "{item.reasoning}"
                          </p>
                        </div>
                      )}
                    </div>

                    <div className="mt-5 pt-4 border-t border-zinc-850/50 flex items-center justify-end">
                      {item.url && (item.url.startsWith("http://") || item.url.startsWith("https://")) ? (
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="bg-emerald-500 hover:bg-emerald-400 text-black px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1"
                        >
                          Apply on Site
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
                      ) : (
                        <span className="text-xs text-zinc-600 italic font-medium">No direct link available</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </>
    ) : (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column - Config */}
        <div className="lg:col-span-5 flex flex-col gap-8">
          {/* Watchlist Setup */}
          <section className="bg-zinc-900/40 backdrop-blur-md rounded-2xl border border-zinc-850 p-6 shadow-xl relative overflow-hidden group">
            <div className="absolute top-0 left-0 w-1 h-full bg-emerald-500/50 group-hover:bg-emerald-400 transition-colors" />
            <h2 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
              🏢 Watchlist Preferences
            </h2>
            <p className="text-xs text-zinc-400 mb-6">
              Track openings from specific companies and configure filtering options.
            </p>
            <form onSubmit={handleAddWatchlist} className="flex flex-col gap-4">
              <div>
                <label className="block text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">Company Name</label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => {
                    setCompanyName(e.target.value);
                    if (!companyIdentifier) {
                      setCompanyIdentifier(e.target.value.toLowerCase().replace(/\s+/g, '-'));
                    }
                  }}
                  placeholder="e.g. Stripe"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500/50 transition-colors"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">Company Identifier (Slug)</label>
                <input
                  type="text"
                  value={companyIdentifier}
                  onChange={(e) => setCompanyIdentifier(e.target.value.toLowerCase())}
                  placeholder="e.g. stripe"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500/50 transition-colors"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">Careers URL</label>
                <input
                  type="url"
                  value={careersUrl}
                  onChange={(e) => setCareersUrl(e.target.value)}
                  placeholder="e.g. https://stripe.com/jobs"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500/50 transition-colors"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">Desired Roles (comma separated)</label>
                <input
                  type="text"
                  value={desiredRolesStr}
                  onChange={(e) => setDesiredRolesStr(e.target.value)}
                  placeholder="e.g. Frontend, Fullstack, Engineer"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500/50 transition-colors"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">Preferred Locations (comma separated)</label>
                <input
                  type="text"
                  value={preferredLocationsStr}
                  onChange={(e) => setPreferredLocationsStr(e.target.value)}
                  placeholder="e.g. Remote, Ahmedabad, Bangalore"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500/50 transition-colors"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">Keywords / Skills (comma separated)</label>
                <input
                  type="text"
                  value={keywordsStr}
                  onChange={(e) => setKeywordsStr(e.target.value)}
                  placeholder="e.g. React, TypeScript, Node"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500/50 transition-colors"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">Notification Frequency</label>
                <select
                  value={notificationFrequency}
                  onChange={(e) => setNotificationFrequency(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500/50 transition-colors"
                >
                  <option value="realtime">Near Real-time</option>
                  <option value="daily">Daily digest</option>
                  <option value="weekly">Weekly digest</option>
                </select>
              </div>
              <button
                type="submit"
                className="mt-2 bg-emerald-500 hover:bg-emerald-400 text-black font-extrabold text-sm py-4 rounded-xl transition-all shadow-lg shadow-emerald-500/10 active:scale-[0.98] flex items-center justify-center gap-2"
              >
                Add to Watchlist
              </button>
            </form>
          </section>

        </div>

        {/* Right Column - Status list */}
        <div className="lg:col-span-7 flex flex-col gap-8">
          {/* Global trigger */}
          <section className="bg-zinc-900/40 backdrop-blur-md rounded-2xl border border-zinc-850 p-6 shadow-xl flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-white">Monitoring Service Status</h3>
              <p className="text-xs text-zinc-450 mt-1 font-medium">
                Autonomous workers run periodic cron tasks to compare job feeds against active preferences.
              </p>
            </div>
            <button
              onClick={handleTriggerWatcherCheck}
              className="bg-teal-500 hover:bg-teal-400 text-black px-5 py-3 rounded-xl text-xs font-bold transition-all shadow-lg shadow-teal-500/10 active:scale-95 flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Scan Watchlist Now
            </button>
          </section>

          {/* Watchlist list */}
          <section className="bg-zinc-900/40 backdrop-blur-md rounded-2xl border border-zinc-850 p-6 shadow-xl flex-1 flex flex-col">
            <h3 className="text-base font-bold text-white mb-6">Your Company Watchlist</h3>

            {loadingWatchlists ? (
              <div className="flex-1 flex justify-center items-center py-12">
                <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : watchlists.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center py-12 border border-dashed border-zinc-800 rounded-xl bg-zinc-950/10 text-center">
                <svg className="w-10 h-10 text-zinc-700 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                </svg>
                <span className="text-sm text-zinc-500 font-medium">No companies on your watchlist yet.</span>
                <span className="text-xs text-zinc-650 mt-1 max-w-sm">Configure and add a company on the left panel to start tracking.</span>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {watchlists.map((item) => {
                  let statusBadge = "bg-zinc-900 border-zinc-800 text-zinc-500";
                  let statusText = item.monitoring_status || 'Pending Discovery';

                  if (['Public API', 'GraphQL Endpoint', 'Static HTML Page'].includes(item.monitoring_status)) {
                    statusBadge = "bg-emerald-950/40 border-emerald-800/30 text-emerald-400";
                  } else if (item.monitoring_status === 'Unsupported' || item.monitoring_status === 'Advanced Scraping Required') {
                    statusBadge = "bg-red-950/40 border-red-900/30 text-red-400";
                  } else if (item.monitoring_status === 'Pending Discovery') {
                    statusBadge = "bg-amber-950/40 border-amber-950/30 text-amber-400";
                  } else if (item.monitoring_status) {
                    statusBadge = "bg-blue-950/40 border-blue-900/30 text-blue-400";
                  }

                  return (
                    <div key={item.id} className="bg-zinc-950/40 border border-zinc-850 p-5 rounded-xl flex flex-col md:flex-row justify-between gap-4 group hover:border-zinc-850 transition-colors">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-2 flex-wrap">
                          <h4 className="text-sm font-bold text-white">{item.company_name}</h4>
                          <span className={`text-[9px] px-2 py-0.5 rounded border font-mono font-medium ${statusBadge}`}>
                            {statusText}
                          </span>
                        </div>
                        <div className="text-xs text-zinc-555 leading-normal flex flex-col gap-1 mb-3 font-medium">
                          <span className="truncate">🔗 <a href={item.careers_url} target="_blank" rel="noreferrer" className="text-emerald-400 hover:underline">{item.careers_url}</a></span>
                          {item.endpoint_url && (
                            <span className="truncate font-mono text-[9px] text-zinc-600 font-semibold mt-1">Endpoint: {item.endpoint_url}</span>
                          )}
                          {statusText === 'Pending Discovery' && (
                            <span className="text-[10px] text-amber-400/90 leading-relaxed font-semibold mt-2 block bg-amber-950/10 border border-amber-900/20 rounded-xl p-3">
                              ⏳ Automatic discovery pending. Please visit the company's careers site in your browser with the extension active to intercept network requests, or click "🔌 Sim Discovery" to the right to simulate traffic.
                            </span>
                          )}
                        </div>
                        
                        {/* Preferences */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 border-t border-zinc-900/60 pt-3">
                          <div>
                            <span className="text-[9px] text-zinc-500 uppercase tracking-wider block">Roles</span>
                            <span className="text-xs text-zinc-300 font-medium truncate block">{item.desired_roles?.join(', ') || 'Any'}</span>
                          </div>
                          <div>
                            <span className="text-[9px] text-zinc-500 uppercase tracking-wider block">Locations</span>
                            <span className="text-xs text-zinc-300 font-medium truncate block">{item.preferred_locations?.join(', ') || 'Any'}</span>
                          </div>
                          <div>
                            <span className="text-[9px] text-zinc-500 uppercase tracking-wider block">Keywords</span>
                            <span className="text-xs text-zinc-300 font-medium truncate block">{item.keywords?.join(', ') || 'None'}</span>
                          </div>
                          <div>
                            <span className="text-[9px] text-zinc-500 uppercase tracking-wider block">Frequency</span>
                            <span className="text-xs text-zinc-300 font-medium capitalize block">{item.notification_frequency}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-row md:flex-col justify-end gap-2 shrink-0 md:self-center">
                        <button
                          onClick={() => handleDeleteWatchlist(item.company_id)}
                          className="bg-red-950/20 hover:bg-red-900/30 text-red-400 border border-red-900/50 hover:border-red-800 px-3 py-2 rounded-lg text-xs font-semibold transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Live Captured Endpoints from Chrome Extension */}
          <section className="bg-zinc-900/40 backdrop-blur-md rounded-2xl border border-zinc-850 p-6 shadow-xl flex flex-col">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">📡 Live Captured Network Endpoints</h3>
                <p className="text-xs text-zinc-500 mt-1">Real API calls intercepted by the Chrome Extension when you visit a careers page.</p>
              </div>
              <span className="text-[10px] font-mono px-2 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-400">
                Auto-refreshing every 5s
              </span>
            </div>

            {discoveredEndpoints.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center py-10 border border-dashed border-zinc-800 rounded-xl bg-zinc-950/10 text-center">
                <div className="text-3xl mb-3">🔌</div>
                <p className="text-sm text-zinc-500 font-medium">No endpoints captured yet</p>
                <p className="text-xs text-zinc-600 mt-2 max-w-xs leading-relaxed">
                  Install the Chrome Extension → Select a company → Visit their careers page. The extension will automatically intercept and report real job API calls here.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3 max-h-96 overflow-y-auto">
                {discoveredEndpoints.map((ep, idx) => (
                  <div key={idx} className={`rounded-xl border p-4 ${
                    ep.saved
                      ? 'bg-emerald-950/20 border-emerald-900/30'
                      : 'bg-zinc-950/40 border-zinc-800'
                  }`}>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <code className="text-xs text-emerald-400 break-all font-mono leading-relaxed flex-1">
                        {ep.requestUrl}
                      </code>
                      <span className="shrink-0 text-[9px] font-bold px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 font-mono">
                        {ep.method}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[9px] text-zinc-500">{ep.companyName}</span>
                      <span className="text-[9px] text-zinc-600">·</span>
                      <span className="text-[9px] text-zinc-500">{new Date(ep.capturedAt).toLocaleTimeString()}</span>
                      {ep.classification && (
                        <span className="text-[9px] px-2 py-0.5 rounded border font-mono font-semibold bg-emerald-950/40 border-emerald-800/30 text-emerald-400">
                          ✓ {ep.classification}
                        </span>
                      )}
                      {ep.confidenceScore && (
                        <span className="text-[9px] text-zinc-500">Confidence: {ep.confidenceScore}%</span>
                      )}
                      {ep.saved && (
                        <span className="text-[9px] px-2 py-0.5 rounded border font-semibold bg-teal-950/40 border-teal-800/30 text-teal-400">
                          🚀 Monitoring Active
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    )}
      </div>
    </div>
  );
}
