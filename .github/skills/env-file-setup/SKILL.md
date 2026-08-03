---
name: env-file-setup
description: "Use when setting up environment variables for a Node.js or Express backend project, creating a .env file, or documenting required secrets and configuration values."
---

# Environment File Setup

## Purpose

Use this skill to create or update a .env file for a backend project safely and clearly. It helps you define required environment variables, explain placeholders, and keep configuration aligned with the project stack.

## When to Use

Use this skill when:
- a project needs a .env file for local development
- environment variables are required for database, JWT, ports, or API access
- you want to scaffold a secure and readable config template
- you need to guide someone through setting up secrets without exposing real values

## Workflow

1. Identify the project type
   - If the project is a Node.js/Express app, include common variables such as PORT, database connection strings, and JWT secrets.
   - If the project uses a different stack, adapt the variables to that stack.

2. Create or update the .env file
   - Place the file at the project root as .env.
   - Use placeholder values for secrets and connection strings.
   - Keep each variable on its own line in KEY=VALUE format.

3. Include the essential variables
   - PORT: the local port for the application
   - MONGODB_URI: the MongoDB connection string
   - JWT_SECRET: a secure secret for authentication tokens
   - Add other variables only if the project clearly requires them

4. Keep the file safe
   - Never commit real credentials or production secrets.
   - Use descriptive placeholder values that show the expected format.
   - If the project already has a .env.example or similar file, mirror its structure.

5. Verify the result
   - Confirm the file exists at the project root.
   - Confirm the variable names are clear and consistent.
   - Confirm the values are placeholders rather than real secrets.

## Template

Use this starter structure when creating a new .env file:

```env
PORT=5000
MONGODB_URI=your_free_mongodb_atlas_connection_string_here
JWT_SECRET=your_super_secret_jwt_key_for_authentication
```

## Completion Checklist

The setup is complete when:
- the .env file exists in the project root
- required variables are present
- placeholder values are safe and obvious
- the file is ready for local development without exposing sensitive data

## Example Prompt

Try prompts like:
- "Create a .env file for this Node.js backend project"
- "Add environment variables for MongoDB and JWT authentication"
- "Set up a safe .env template for local development"
