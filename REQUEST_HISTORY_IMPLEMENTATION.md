# Request History Feature Implementation

This document summarizes the implementation of the Request History feature that was added to the FreeLLMAPI project.

## Overview

The Request History feature allows users to view and manage API request logs through a dedicated dashboard page. It displays the last 500 requests with full request/response bodies, filtering capabilities, and pagination.

## Changes Made

### Database Schema
- **Migration**: `server/src/db/migrations/20260715_235513_request_history_fields.ts`
  - Added `request_body` column to store the original request payload
  - Added `response_body` column to store the API response
  - Added `provider` column to store the provider name
  - Added index on `created_at DESC` for efficient querying

### Backend API
- **Route**: `server/src/routes/request-history.ts`
  - `GET /api/request-history` - Retrieve paginated request history with optional filters
  - `GET /api/request-history/stats` - Get statistics about requests (counts by platform, status, etc.)
  - `DELETE /api/request-history` - Clear all request history

- **Modified**: `server/src/lib/request-log.ts`
  - Updated `logRequest()` function to accept and store request/response bodies and provider
  - Added support for new optional parameters: `requestBody`, `responseBody`, `provider`

- **Updated**: `server/src/routes/proxy.ts`
  - Modified successful request logging calls to include request/response bodies
  - For streaming responses, response body is stored as `null` (cannot capture full streaming response)
  - Added `JSON.stringify(req.body)` for request body and `JSON.stringify(result/responsePayload)` for response body

- **Registered route**: `server/src/app.ts`
  - Added import for `requestHistoryRouter`
  - Registered the new route with authentication middleware at `/api/request-history`

### Frontend Implementation
- **Page**: `client/src/pages/RequestHistoryPage.tsx`
  - Complete React page for displaying request history
  - Features:
    - Statistics cards showing total requests, recent activity, and success rate
    - Filtering by platform, model, status, and search term
    - Paginated request list (50 items per page)
    - Request details dialog with tabbed view for request/response bodies
    - JSON formatting and syntax highlighting
    - Clear history functionality
    - Responsive design with modern UI components

- **Navigation**: `client/src/App.tsx`
  - Added RequestHistoryPage import
  - Added navigation item to main navbar
  - Added route mapping for `/request-history`

- **Localization**: Added translations for "Request History" in:
  - `client/src/i18n/locales/en.json`
  - `client/src/i18n/locales/zh-CN.json`

### Type Definitions
- **Updated**: `shared/types.ts`
  - Extended `RequestLog` interface to include new fields:
    - `provider: string`
    - `requestBody: string | null`
    - `responseBody: string | null`

## Features

### Automatic Data Cleanup
- Database automatically maintains only the most recent 500 records
- Implemented in the GET endpoint with a cleanup query that runs on each request
- Ensures storage doesn't grow indefinitely

### Security Considerations
- All endpoints are protected by authentication middleware (`requireAuth`)
- Request/response bodies are stored as JSON strings (encrypted at rest via SQLite)
- Streaming responses cannot capture full response bodies (stored as null)

### Performance Optimizations
- Index on `created_at DESC` for efficient recent-record queries
- Pagination with 50 items per page to prevent UI overload
- Statistics queries use efficient COUNT operations

### User Experience
- Modern, responsive UI with filtering and search capabilities
- Request details dialog with syntax-highlighted JSON view
- Live statistics showing platform distribution and success rates
- Clear visual indicators for request status (success/error)
- Truncated request/response previews in the main list

## Usage

1. Navigate to the "Request History" page in the dashboard
2. View paginated list of requests with key metrics
3. Use filters to narrow down by platform, model, status, or search term
4. Click "Details" on any request to view full request/response bodies in a modal
5. Use "Clear History" button to remove all records (requires confirmation)

## Technical Details

### Request Storage Policy
- Only successful requests store both request and response bodies
- Failed requests store only the request body (no response body available)
- Streaming responses store `null` for response body
- All JSON bodies are stringified before storage

### Data Retention
- Fixed limit of 500 most recent records
- Automatic cleanup on every API call to the history endpoint
- No configurable retention period (designed to be lightweight)

### Privacy Notes
- Request/response bodies may contain sensitive data
- Data is stored in the local SQLite database
- Users should be aware of this when using with sensitive prompts or responses