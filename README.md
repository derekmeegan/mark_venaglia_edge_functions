# Venaglia Edge Functions

This repository contains Supabase Edge Functions for web scraping and email handling, deployed using GitHub Actions.

## Overview

The repository includes two main edge functions:

1. **scrape-reviews**: A Deno-based edge function that scrapes TripAdvisor reviews using Playwright and Browserbase, then stores the data in a Supabase database.
2. **send-email**: A simple edge function that processes contact form submissions and sends emails using SendGrid.

## Technologies Used

- [Deno](https://deno.land/) - The JavaScript/TypeScript runtime used for edge functions
- [Supabase](https://supabase.com/) - Backend-as-a-Service platform for hosting the edge functions
- [Playwright](https://playwright.dev/) - Browser automation library for web scraping
- [Browserbase](https://browserbase.com/) - Headless browser infrastructure for web scraping
- [SendGrid](https://sendgrid.com/) - Email delivery service
- [GitHub Actions](https://github.com/features/actions) - CI/CD for automatic deployment

## Edge Functions

### scrape-reviews

This function scrapes TripAdvisor reviews for a specific attraction:

- Uses Playwright with Browserbase for headless browser automation
- Scrapes multiple pages of reviews (configurable)
- Extracts detailed review data including:
  - Reviewer information (name, profile, avatar)
  - Review content (title, text, rating)
  - Metadata (date, trip type, helpful votes)
- Stores the scraped data in a Supabase database table named "reviews"
- Handles pagination and error cases

#### Environment Variables Required:
- `BROWSERBASE_API_KEY` - API key for Browserbase
- `BROWSERBASE_PROJECT_ID` - Project ID for Browserbase
- `SUPABASE_URL` - URL of your Supabase project
- `SUPABASE_ANON_KEY` - Anonymous key for Supabase API access

### send-email

This function processes contact form submissions:

- Receives form data (name, email, subject, message)
- Forwards the information via SendGrid to a specified email address
- Handles CORS and provides appropriate responses

#### Environment Variables Required:
- `SENDGRID_API_KEY` - API key for SendGrid email service

## Deployment

The edge functions are automatically deployed to Supabase using GitHub Actions when changes are pushed to the main branch.

### GitHub Actions Workflow

The deployment workflow:
1. Triggers on push to main branch or manual workflow dispatch
2. Sets up the Supabase CLI
3. Deploys all functions to the specified Supabase project

#### Environment Variables Required for Deployment:
- `SUPABASE_ACCESS_TOKEN` - Access token for Supabase
- `PROJECT_ID` - Supabase project ID
