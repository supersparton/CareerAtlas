"use client";

import React, { useState, useEffect } from "react";
import {
  Check,
  Edit2,
  Trash2,
  FileText,
  Plus,
  User,
  Mail,
  Phone,
  Briefcase,
  GraduationCap,
  FolderGit2,
  Award,
  Sparkles,
  ChevronDown,
  ChevronUp
} from "lucide-react";
import { getUserEmail, getAuthHeaders, isAuthenticated } from "../../utils/auth";
import { CareerAtlasLogoMark } from "@/components/ui/CareerAtlasLogoMark";
import { AppShell } from "../../components/AppShell";
import { ConfirmModal } from "../../components/ui/ConfirmModal";

interface ResumeVersion {
  id: number;
  versionName: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  parsedData: {
    fullName?: string;
    email?: string;
    phone?: string;
    skills?: any[];
    experienceYears?: number | string;
    education?: any[];
    projects?: any[];
    achievements?: any[];
    preferredRoles?: any[];
    targetRole?: string;
    experienceLevel?: string;
  };
}

import { useRouter } from "next/navigation";

export default function ResumeManagerPage() {
  const router = useRouter();
  const [versions, setVersions] = useState<ResumeVersion[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState<string>("");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [uploading, setUploading] = useState<boolean>(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
      return;
    }
    fetchVersions();
  }, [router]);

  const fetchVersions = async () => {
    setLoading(true);
    try {
      const email = getUserEmail();
      const emailParam = email ? `?email=${encodeURIComponent(email)}` : "";
      const res = await fetch(`/api/profile/versions${emailParam}`, {
        headers: getAuthHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setVersions(data || []);
        if (data && data.length > 0 && expandedId === null) {
          setExpandedId(data[0].id);
        }
      }
    } catch (e: any) {
      setStatusMsg(`Error loading versions: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleActivate = async (id: number) => {
    try {
      const email = getUserEmail();
      const emailParam = email ? `?email=${encodeURIComponent(email)}` : "";
      const res = await fetch(`/api/profile/versions/${id}/activate${emailParam}`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (res.ok) {
        setStatusMsg("Successfully set version as active!");
        fetchVersions();
      } else {
        throw new Error(await res.text());
      }
    } catch (e: any) {
      setStatusMsg(`Failed to activate version: ${e.message}`);
    }
  };

  const handleStartRename = (v: ResumeVersion) => {
    setEditingId(v.id);
    setEditName(v.versionName);
  };

  const handleSaveRename = async (id: number) => {
    if (!editName.trim()) return;
    try {
      const email = getUserEmail();
      const emailParam = email ? `?email=${encodeURIComponent(email)}` : "";
      const res = await fetch(`/api/profile/versions/${id}${emailParam}`, {
        method: "PATCH",
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ versionName: editName.trim() }),
      });

      if (res.ok) {
        setEditingId(null);
        setStatusMsg("Version renamed successfully.");
        fetchVersions();
      } else {
        throw new Error(await res.text());
      }
    } catch (e: any) {
      setStatusMsg(`Failed to rename: ${e.message}`);
    }
  };

  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);

  const handleDelete = (id: number, name: string) => {
    setDeleteTarget({ id, name });
  };

  const executeDelete = async () => {
    if (!deleteTarget) return;
    const { id, name } = deleteTarget;
    setDeleteTarget(null);
    try {
      const email = getUserEmail();
      const emailParam = email ? `?email=${encodeURIComponent(email)}` : "";
      const res = await fetch(`/api/profile/versions/${id}${emailParam}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });

      if (res.ok) {
        setStatusMsg(`Deleted version "${name}".`);
        fetchVersions();
      } else {
        throw new Error(await res.text());
      }
    } catch (e: any) {
      setStatusMsg(`Failed to delete version: ${e.message}`);
    }
  };

  const handleDirectUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setUploading(true);
      setStatusMsg("Uploading and parsing PDF...");
      try {
        const email = getUserEmail() || "user@example.com";
        const formData = new FormData();
        formData.append("resume", file);
        formData.append("email", email);

        const res = await fetch("/api/profile/upload-stream", {
          method: "POST",
          headers: getAuthHeaders(),
          body: formData,
        });

        if (!res.ok) throw new Error(await res.text());
        const { eventUrl } = await res.json();
        const eventSource = new EventSource(eventUrl);

        eventSource.onmessage = (event) => {
          const sse = JSON.parse(event.data);
          if (sse.status === "completed") {
            eventSource.close();
            setUploading(false);
            setStatusMsg("New version uploaded and parsed successfully!");
            fetchVersions();
          } else if (sse.status === "error") {
            eventSource.close();
            setUploading(false);
            setStatusMsg(`Error: ${sse.errorDetails}`);
          }
        };
        eventSource.onerror = () => {
          eventSource.close();
          setUploading(false);
          fetchVersions();
        };
      } catch (err: any) {
        setUploading(false);
        setStatusMsg(`Upload failed: ${err.message}`);
      }
    }
  };

  const renderItemText = (item: any): string => {
    if (typeof item === "string") return item.trim();
    if (typeof item === "number" || typeof item === "boolean") return String(item);
    if (item && typeof item === "object") {
      const parts: string[] = [];
      if (item.degree || item.title || item.name || item.role) {
        parts.push(item.degree || item.title || item.name || item.role);
      }
      if (item.institution || item.university || item.school || item.company) {
        parts.push(item.institution || item.university || item.school || item.company);
      }
      if (item.year || item.duration || item.date) {
        parts.push(`(${item.year || item.duration || item.date})`);
      }
      if (item.description || item.summary || item.details) {
        parts.push(`- ${item.description || item.summary || item.details}`);
      }
      if (item.techStack && Array.isArray(item.techStack)) {
        parts.push(`[Stack: ${item.techStack.join(", ")}]`);
      }
      if (parts.length > 0) return parts.join(" ");
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    }
    return "";
  };

  const formatExperience = (exp?: number | string) => {
    const num = typeof exp === "number" ? exp : parseFloat(String(exp || "0"));
    if (num > 0) {
      return `${num} ${num === 1 ? "Year" : "Years"} Experience`;
    }
    return "Entry Level / Academic (0-1 Years)";
  };

  const resolveRoles = (data: ResumeVersion["parsedData"]) => {
    if (data.preferredRoles && data.preferredRoles.length > 0) {
      return data.preferredRoles.map(r => renderItemText(r)).filter(Boolean);
    }
    if (data.targetRole) {
      return [renderItemText(data.targetRole)];
    }
    if (data.skills && data.skills.length > 0) {
      const skillStr = data.skills.map(s => renderItemText(s)).join(" ").toLowerCase();
      const inferred: string[] = [];
      if (skillStr.includes("react") || skillStr.includes("javascript") || skillStr.includes("html")) {
        inferred.push("Software Engineer", "Frontend Developer");
      } else if (skillStr.includes("python") || skillStr.includes("sql") || skillStr.includes("data")) {
        inferred.push("Data Engineer", "Backend Developer");
      } else {
        inferred.push("Software Engineer");
      }
      return inferred;
    }
    return ["Software Engineer"];
  };

  return (
    <AppShell>
      <div className="min-h-screen bg-[#FFFBF7] text-[#664930] font-sans antialiased">
        <div className="px-6 py-5 border-b border-[#CCBEB1] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <CareerAtlasLogoMark size={28} showText />
            <span className="text-[10px] font-mono bg-[#FFDBBB] text-[#664930] px-2 py-0.5 rounded border border-[#CCBEB1] font-bold">
              RESUME VAULT
            </span>
          </div>
        </div>

      <div className="max-w-6xl mx-auto px-6 py-10 font-sans">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 pb-8 border-b border-[#CCBEB1] mb-10">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="h-2 w-2 rounded-full bg-[#664930] animate-pulse" />
              <span className="text-xs font-mono font-bold text-[#664930] uppercase">MULTI-VERSION VAULT</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-extrabold text-[#664930] tracking-tight font-sans">
              Resume Version Manager
            </h1>
            <p className="text-sm text-[#997E67] mt-1 font-sans">
              Complete view of all extracted technical taxonomies, candidate metadata, and role variations.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <label className="cursor-pointer inline-flex items-center gap-2 bg-[#664930] hover:bg-[#523a26] text-white text-xs font-bold px-4 py-2.5 rounded-xl transition-all shadow-md active:scale-95 font-sans">
              {uploading ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Processing PDF...</span>
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" />
                  <span>Upload New Version</span>
                  <input
                    type="file"
                    accept=".pdf"
                    className="hidden"
                    onChange={handleDirectUpload}
                    disabled={uploading}
                  />
                </>
              )}
            </label>
          </div>
        </div>

        {statusMsg && (
          <div className="mb-6 p-4 rounded-xl bg-white border border-[#CCBEB1] text-xs font-mono text-[#664930] flex items-center justify-between shadow-xs">
            <span>{statusMsg}</span>
            <button onClick={() => setStatusMsg("")} className="text-[#997E67] hover:text-[#664930]">✕</button>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 border border-dashed border-[#CCBEB1] rounded-2xl bg-[#FFFBF7]">
            <div className="w-8 h-8 border-4 border-[#664930] border-t-transparent rounded-full animate-spin mb-3" />
            <span className="text-sm text-[#997E67] font-mono">Loading stored resume versions...</span>
          </div>
        ) : versions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 border border-dashed border-[#CCBEB1] rounded-2xl bg-[#FFFBF7] text-center font-sans">
            <FileText className="w-12 h-12 text-[#CCBEB1] mb-3" />
            <span className="text-sm font-bold text-[#664930] mb-1">No Resume Versions Saved Yet</span>
            <span className="text-xs text-[#997E67] max-w-sm">
              Upload your first PDF resume above to create a version record in your account.
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 font-sans">
            {versions.map((v) => {
              const isEditing = editingId === v.id;
              const data = v.parsedData || {};
              const roles = resolveRoles(data);
              const isExpanded = expandedId === v.id;

              return (
                <div
                  key={v.id}
                  className={`rounded-2xl border transition-all duration-200 bg-white overflow-hidden ${
                    v.isActive
                      ? "border-[#664930] shadow-md"
                      : "border-[#CCBEB1] hover:border-[#997E67]"
                  }`}
                >
                  <div className="p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#CCBEB1]">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 rounded-xl bg-[#FFDBBB] flex items-center justify-center text-[#664930] shrink-0 border border-[#CCBEB1]">
                        <FileText className="w-6 h-6 text-[#664930]" />
                      </div>

                      <div className="min-w-0">
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              className="bg-[#FFFBF7] border border-[#664930] rounded px-3 py-1 text-sm text-[#664930] focus:outline-none"
                              autoFocus
                            />
                            <button
                              onClick={() => handleSaveRename(v.id)}
                              className="bg-[#664930] text-white p-1.5 rounded hover:bg-[#523a26]"
                            >
                              <Check className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="bg-[#CCBEB1] text-[#664930] p-1.5 rounded"
                            >
                              ✕
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2.5">
                            <h3 className="text-lg font-bold text-[#664930] truncate font-sans">
                              {v.versionName}
                            </h3>
                            <button
                              onClick={() => handleStartRename(v)}
                              className="text-[#997E67] hover:text-[#664930] transition-colors"
                              title="Rename Version"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}

                        <span className="text-xs text-[#997E67] font-mono block mt-0.5">
                          Uploaded: {new Date(v.createdAt).toLocaleDateString()} • Updated: {new Date(v.updatedAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      {v.isActive ? (
                        <span className="inline-flex items-center gap-1.5 bg-[#FFDBBB] border border-[#CCBEB1] text-[#664930] text-xs font-mono font-bold px-3.5 py-1.5 rounded-lg shadow-xs">
                          <span className="w-2 h-2 rounded-full bg-[#664930] animate-pulse" />
                          PRIMARY / ACTIVE
                        </span>
                      ) : (
                        <button
                          onClick={() => handleActivate(v.id)}
                          className="bg-[#FFFBF7] hover:bg-[#FFDBBB] text-[#664930] border border-[#CCBEB1] text-xs font-semibold px-3.5 py-1.5 rounded-lg transition-colors font-sans"
                        >
                          Set as Active
                        </button>
                      )}

                      <button
                        onClick={() => handleDelete(v.id, v.versionName)}
                        className="text-red-700 hover:text-red-800 p-2 rounded-lg hover:bg-red-50 transition-colors"
                        title="Delete Version"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>

                      <button
                        onClick={() => setExpandedId(isExpanded ? null : v.id)}
                        className="text-[#664930] hover:text-[#523a26] p-2 rounded-lg bg-[#FFDBBB] hover:bg-[#ffcd9e] border border-[#CCBEB1] transition-colors flex items-center gap-1 text-xs font-bold font-sans"
                      >
                        <span>{isExpanded ? "Collapse" : "View All Details"}</span>
                        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div className="p-6 bg-[#FFFBF7] border-b border-[#CCBEB1] grid grid-cols-1 md:grid-cols-3 gap-4 font-sans">
                    <div className="space-y-1">
                      <span className="text-[10px] font-mono uppercase text-[#997E67] block">Candidate Identity</span>
                      <div className="flex items-center gap-2 text-sm font-bold text-[#664930]">
                        <User className="w-4 h-4 text-[#664930]" />
                        <span>{data.fullName ? renderItemText(data.fullName) : "Candidate Profile"}</span>
                      </div>
                      <div className="text-xs text-[#997E67] flex flex-wrap items-center gap-3 mt-1">
                        {data.email && (
                          <span className="flex items-center gap-1">
                            <Mail className="w-3 h-3 text-[#997E67]" />
                            {renderItemText(data.email)}
                          </span>
                        )}
                        {data.phone && (
                          <span className="flex items-center gap-1">
                            <Phone className="w-3 h-3 text-[#997E67]" />
                            {renderItemText(data.phone)}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <span className="text-[10px] font-mono uppercase text-[#997E67] block">Target & Preferred Roles</span>
                      <div className="flex flex-wrap gap-1.5">
                        {roles.map((role, idx) => (
                          <span key={idx} className="bg-[#FFDBBB] border border-[#CCBEB1] text-[#664930] text-xs font-bold px-2.5 py-0.5 rounded-lg">
                            {role}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <span className="text-[10px] font-mono uppercase text-[#997E67] block">Seniority & Experience Level</span>
                      <div className="text-sm font-bold text-[#664930] flex items-center gap-2">
                        <Briefcase className="w-4 h-4 text-[#664930]" />
                        <span>{formatExperience(data.experienceYears)}</span>
                      </div>
                      {data.experienceLevel && (
                        <span className="text-xs text-[#997E67] block">{renderItemText(data.experienceLevel)}</span>
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="p-6 space-y-6 bg-white font-sans">
                      <div>
                        <h4 className="text-xs font-mono uppercase text-[#664930] font-bold mb-3 flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-[#664930]" />
                          Extracted Technical Skills & Stack ({data.skills?.length || 0})
                        </h4>
                        {data.skills && data.skills.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {data.skills.map((skill, idx) => {
                              const skillText = renderItemText(skill);
                              if (!skillText) return null;
                              return (
                                <span key={idx} className="bg-[#FFDBBB] border border-[#CCBEB1] text-[#664930] text-xs font-mono font-bold px-2.5 py-1 rounded-md">
                                  {skillText}
                                </span>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="text-xs text-[#997E67] italic">No skills extracted</span>
                        )}
                      </div>

                      <div>
                        <h4 className="text-xs font-mono uppercase text-[#664930] font-bold mb-3 flex items-center gap-2">
                          <GraduationCap className="w-4 h-4 text-[#664930]" />
                          Education & Qualifications
                        </h4>
                        {data.education && data.education.length > 0 ? (
                          <div className="space-y-2">
                            {data.education.map((edu, idx) => {
                              const text = renderItemText(edu);
                              if (!text) return null;
                              return (
                                <div key={idx} className="bg-[#FFFBF7] p-3 rounded-xl border border-[#CCBEB1] text-xs text-[#664930] flex items-start gap-2 font-medium">
                                  <span className="text-[#664930] font-bold">•</span>
                                  <span>{text}</span>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="text-xs text-[#997E67] italic">No education items recorded</span>
                        )}
                      </div>

                      <div>
                        <h4 className="text-xs font-mono uppercase text-[#664930] font-bold mb-3 flex items-center gap-2">
                          <FolderGit2 className="w-4 h-4 text-[#664930]" />
                          Projects & Technical Accomplishments
                        </h4>
                        {data.projects && data.projects.length > 0 ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {data.projects.map((proj, idx) => {
                              const text = renderItemText(proj);
                              if (!text) return null;
                              return (
                                <div key={idx} className="bg-[#FFFBF7] p-3.5 rounded-xl border border-[#CCBEB1] text-xs text-[#664930]">
                                  <span className="text-[#664930] font-bold block mb-1">Project #{idx + 1}</span>
                                  <p className="text-[#664930] leading-relaxed font-normal">{text}</p>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="text-xs text-[#997E67] italic">No project entries recorded</span>
                        )}
                      </div>

                      {data.achievements && data.achievements.length > 0 && (
                        <div>
                          <h4 className="text-xs font-mono uppercase text-[#664930] font-bold mb-3 flex items-center gap-2">
                            <Award className="w-4 h-4 text-[#664930]" />
                            Extracted Achievements & Certifications
                          </h4>
                          <div className="space-y-2">
                            {data.achievements.map((ach, idx) => {
                              const text = renderItemText(ach);
                              if (!text) return null;
                              return (
                                <div key={idx} className="bg-[#FFFBF7] p-3 rounded-xl border border-[#CCBEB1] text-xs text-[#664930] flex items-start gap-2">
                                  <span className="text-[#664930] font-bold">🏆</span>
                                  <span>{text}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>

      <ConfirmModal
        isOpen={!!deleteTarget}
        title="Delete Resume Version"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This action will permanently remove this version.`}
        confirmLabel="Delete Version"
        isDanger={true}
        onConfirm={executeDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </AppShell>
  );
}
