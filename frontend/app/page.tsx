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
  preferences: string;
  targetLocation: string;
  isRemoteOpen: boolean;
  experience: ResumeWorkExperience[];
  projects: ResumeProject[];
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
  
  // Status and logs
  const [logs, setLogs] = useState<string[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState<boolean>(false);
  const [workflowRunning, setWorkflowRunning] = useState<boolean>(false);

  // Load existing profile on mount if available
  useEffect(() => {
    fetchProfile();
  }, []);

  const addLog = (message: string) => {
    setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${message}`, ...prev]);
  };

  const fetchProfile = async () => {
    try {
      const res = await fetch("/api/profile");
      if (res.ok) {
        const data = await res.json();
        if (data && data.fullName && data.fullName !== "Default User" && data.fullName !== "No Resume Uploaded") {
          setProfile(data);
          setLocationPref(data.targetLocation || "Ahmedabad");
          setIsRemoteOpen(data.isRemoteOpen ?? true);
          addLog("Loaded existing profile from backend cache.");
          fetchSuggestions();
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

      const parsedData: ParsedProfile = await res.json();
      setProfile(parsedData);
      setLocationPref(parsedData.targetLocation || "Ahmedabad");
      setIsRemoteOpen(parsedData.isRemoteOpen ?? true);
      addLog(`Resume parsed successfully for ${parsedData.fullName}!`);
      
      // Auto-fetch suggestions after upload
      await fetchSuggestions();
    } catch (e: any) {
      addLog(`Error parsing resume: ${e.message}`);
    } finally {
      setParsing(false);
    }
  };

  const fetchSuggestions = async () => {
    setLoadingSuggestions(true);
    addLog("Requesting recommended job titles based on your resume stack...");
    try {
      const res = await fetch("/api/profile/suggest-titles");
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
    if (cleanTerm && !searchTerms.includes(cleanTerm)) {
      setSearchTerms((prev) => [...prev, cleanTerm]);
      setNewTermInput("");
      addLog(`Added title: "${cleanTerm}"`);
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
    addLog("Triggering parallel scraping agents loop in background...");
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchTerms,
          locationPreference: locationPref,
          isRemoteOpen,
        }),
      });

      if (!res.ok) {
        throw new Error(await res.text() || "Failed to trigger agent.");
      }

      const result = await res.json();
      addLog(`Pipeline Activated! ${result.message}`);
      addLog(`Running scraping agents for titles: ${searchTerms.join(", ")}`);
    } catch (e: any) {
      addLog(`Error running workflow: ${e.message}`);
    } finally {
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
            <span className="text-xs bg-zinc-900 px-3 py-1.5 rounded-full border border-zinc-800 text-zinc-400">
              NestJS Endpoint: <code className="text-zinc-300 font-mono">localhost:3001</code>
            </span>
          </div>
        </header>

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

                {/* Search Term Tags */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                      Target Job Search Titles
                    </label>
                    {profile && (
                      <button
                        onClick={fetchSuggestions}
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
                      <span className="text-sm text-zinc-600 self-center">No search titles added yet. Parse resume or add manually.</span>
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
                      placeholder="e.g. Node.js Backend Developer"
                      className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50 transition-colors"
                    />
                    <button
                      type="submit"
                      className="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-semibold text-sm px-4 rounded-xl transition-all"
                    >
                      Add Title
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
      </div>
    </div>
  );
}
