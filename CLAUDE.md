@AGENTS.md
# Hackathon Project Context
We are in a 4-hour hackathon. Speed and working features are the ONLY priorities. 

## Workflow & Tradeoffs
- **No Over-engineering:** Build the simplest, dirtiest thing that works. We refactor nothing today.
- **Hardcode First:** Use mock data aggressively. Only connect to the real database when the UI is fully functional.
- **Skip Tests:** Do not write unit tests or test files unless explicitly asked.
- **Conventions:** Use TypeScript. Use Tailwind for all styling. Use npm (the repo has `package-lock.json`). There is no Shadcn/`components/ui/` directory.

## Verification (CRITICAL)
- Never claim a UI change works without verifying it. 
- If a build fails or an error occurs, use the terminal to read the error logs directly. Do not guess the fix.

## Commands
- Run dev server: `npm run dev`
- Build project: `npm run build`