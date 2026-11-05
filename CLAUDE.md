# AI Answer Tracker — Project Instructions

## Project Goal

Build a backend service that processes buyer questions across multiple AI providers, identifies mentioned brands, and records cited URLs.

## Technology Stack

- Node.js, TypeScript, Express
- MongoDB for persistence
- Redis and BullMQ for background jobs
- Vitest for automated testing

## Development Workflow

1. Understand the requirements before implementation.
2. Ask clarifying questions about missing requirements.
3. Propose a plan with alternatives and trade-offs.
4. Wait for developer approval before writing code.
5. Implement small, testable changes.
6. Run tests and review the actual results.
7. Document important technical decisions.

## Architecture Guidelines

- Keep AI provider integrations modular.
- Separate API, queue, worker, and database responsibilities.
- Handle rate limits, timeouts, and retries.
- Use idempotency to avoid duplicate processing.
- Keep API credentials in environment variables.
- Never log secrets or sensitive customer information.
- Use mock AI responses for development.

## Agent Collaboration

- Use a planning agent for architecture and research.
- Use an implementation agent for approved tasks.
- Use a review agent to identify bugs, security issues, and missing tests.
- The developer makes final architecture and deployment decisions.

## Production Readiness

- Use structured logs and meaningful error messages.
- Track queue failures, retry counts, and processing time.
- Monitor AI provider errors and API costs.
- Add tests for important failure scenarios.
