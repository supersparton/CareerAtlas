# Skill: Technical Diagram & Architecture Design Expert

## Purpose

Generate visually professional, executive-grade technical diagrams, flowcharts, architecture documents, system designs, ERDs, sequence diagrams, Mermaid diagrams, Excalidraw layouts, Eraser.io diagrams, and engineering documentation.

The objective is not merely correctness.

The objective is:

* Maximum readability
* Minimum cognitive load
* Consistent visual hierarchy
* Professional presentation quality
* Stakeholder-friendly communication
* Engineering accuracy

---

# Core Principles

## Rule 1: Flow Direction

Always prefer:

Left → Right

for:

* System Architecture
* API Flows
* Agent Workflows
* Data Pipelines

Use:

Top → Bottom

only for:

* Decision Trees
* Approval Workflows
* User Journeys
* Organizational Processes

Never mix directions unless absolutely required.

---

## Rule 2: Visual Hierarchy

The viewer should understand the system in under 15 seconds.

Hierarchy:

1. Actors
2. Major Systems
3. Services
4. Internal Components
5. Datastores
6. External Integrations

Importance decreases as you move downward.

---

## Rule 3: Minimize Line Crossings

Bad diagrams have many crossing connections.

Requirements:

* Keep edges straight
* Prefer orthogonal connectors
* Avoid diagonal spaghetti lines
* Route connections around components
* Group related nodes together

---

# Layout Standards

## Small Diagram

5–10 nodes

Layout:

Actor → System → Database

Single horizontal row.

---

## Medium Diagram

10–25 nodes

Layout:

Actors

↓

Frontend Layer

↓

API Layer

↓

Service Layer

↓

Data Layer

↓

External Systems

---

## Large Architecture

25+ nodes

Use layers.

Example:

Actors
│
Presentation Layer
│
Gateway Layer
│
Business Layer
│
AI Layer
│
Data Layer
│
Infrastructure Layer

---

# Grid System

Always align nodes to a virtual grid.

Spacing:

Horizontal Gap:
160px–220px

Vertical Gap:
120px–180px

Node Alignment:

✓ Perfectly aligned

✗ Random placement

---

# Node Shapes

## Actor

Shape:
Stick Figure or Rounded Rectangle

Examples:

* User
* Admin
* Banker
* Retailer
* Maker
* Checker

---

## UI Components

Shape:
Rounded Rectangle

Examples:

* Web Portal
* Dashboard
* Mobile App

Radius:
12px

---

## Services

Shape:
Rectangle

Examples:

* Auth Service
* BRE Engine
* Notification Service
* AI Service

---

## AI Agents

Shape:
Hexagon

Examples:

* Resume Agent
* Scoring Agent
* Classification Agent
* Research Agent

Hexagons visually distinguish intelligence layers.

---

## Decision Nodes

Shape:
Diamond

Examples:

* Eligible?
* Approved?
* Score > Threshold?

Maximum:
1–2 decisions per screen area.

---

## Databases

Shape:
Cylinder

Examples:

* PostgreSQL
* MongoDB
* Redis
* Vector DB

---

## Queues

Shape:
Parallelogram

Examples:

* Kafka
* RabbitMQ
* SQS

---

## Storage

Shape:
Folder or Bucket

Examples:

* S3
* Blob Storage
* Document Repository

---

## External Systems

Shape:
Dashed Rectangle

Examples:

* Salesforce
* GSTN
* LinkedIn
* Gmail
* Razorpay

---

# Color Palette

Use maximum 6 colors.

## Primary

Blue

Purpose:

* Core platform
* Internal services

Color:
#2563EB

---

## Success

Green

Purpose:

* Completed states
* Success paths

Color:
#16A34A

---

## Warning

Amber

Purpose:

* Manual review
* Pending actions

Color:
#D97706

---

## Error

Red

Purpose:

* Failure path
* Rejections

Color:
#DC2626

---

## AI Components

Purple

Purpose:

* LLMs
* Agents
* AI Pipelines

Color:
#7C3AED

---

## Infrastructure

Gray

Purpose:

* Databases
* Storage
* Queues

Color:
#6B7280

---

# Typography

Primary Font:

Inter

Fallback:

Roboto

Fallback:

Arial

---

# Font Sizes

Diagram Title:
24px

Layer Headers:
18px

Node Labels:
14px

Connection Labels:
12px

Footnotes:
10px

---

# Labeling Rules

Good:

Auth Service

Bad:

authentication-service-v2-prod

---

Good:

Resume Scoring Agent

Bad:

resume_scoring_agent_microservice

---

Use business-readable names.

---

# Layering Standards

Always organize architecture into layers.

Example:

Actors

↓

Frontend

↓

API Gateway

↓

Business Services

↓

AI Services

↓

Data Layer

↓

External Systems

---

# Connection Rules

Solid Arrow

Meaning:

Synchronous

Example:

REST API

---

Dashed Arrow

Meaning:

Asynchronous

Example:

Kafka Event

---

Dotted Arrow

Meaning:

Optional

Example:

Fallback Process

---

Double Arrow

Meaning:

Bidirectional

Example:

WebSocket

---

# AI Architecture Rules

AI components must be grouped together.

Never scatter agents throughout the system.

Create:

AI Layer

Containing:

* Planner
* Research Agent
* Scoring Agent
* LLM Router
* Memory Manager

This dramatically improves readability.

---

# Database Presentation Rules

Never show raw tables in architecture diagrams.

Show:

PostgreSQL

Instead of:

users
transactions
audit_logs

Table-level details belong in ERDs.

---

# Documentation Companion

Every diagram should include:

## Objective

What the system does.

## Actors

Who interacts with it.

## Flow

Step-by-step explanation.

## Assumptions

Technical assumptions.

## Constraints

Known limitations.

## Future Enhancements

Scalability roadmap.

---

# Mermaid Standards

Preferred Direction:

flowchart LR

Avoid:

flowchart TD

unless process-oriented.

Node Naming:

Short labels.

Subgraphs:

Mandatory for:

* Services
* AI Layer
* Data Layer

Maximum nesting:

2 levels.

---

# Excalidraw Standards

Use:

* Consistent spacing
* Consistent sizing
* Minimal colors
* Layer grouping
* Aligned connectors

Never create "whiteboard chaos."

Aim for:

Enterprise architecture review quality.

---

# Eraser.io Standards

Preferred:

Architecture Diagram

for systems.

Sequence Diagram

for interactions.

Data Flow Diagram

for pipelines.

ERD

for schemas.

Decision Tree

for approval logic.

---

# Quality Checklist

Before finalizing any diagram verify:

✓ Left-to-right readability

✓ No overlapping nodes

✓ No unnecessary colors

✓ Consistent spacing

✓ Clear actor identification

✓ AI layer separated

✓ Database layer separated

✓ Minimal line crossings

✓ Business-readable labels

✓ Professional presentation quality

If any check fails, redesign the diagram.
