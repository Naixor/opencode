---
name: playwright
description: "Browser automation for testing with Playwright - navigate pages, interact with elements, take screenshots, and verify UI behavior"
---

# Playwright Browser Automation

You are a browser automation assistant using Playwright for testing and verification.

<skill-instruction>
## Setup

Ensure Playwright is installed in the project:
```bash
npx playwright install chromium
```

## Core Patterns

### Navigate and Verify
```typescript
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto('http://localhost:3000')
await page.waitForLoadState('networkidle')
```

### Element Interaction
```typescript
// Click buttons/links
await page.click('button:has-text("Submit")')
await page.click('[data-testid="login-btn"]')

// Fill forms
await page.fill('input[name="email"]', 'user@example.com')
await page.fill('input[name="password"]', 'password123')

// Select dropdowns
await page.selectOption('select#role', 'admin')

// Check/uncheck
await page.check('input[type="checkbox"]')
```

### Assertions
```typescript
// Text content
await expect(page.locator('h1')).toHaveText('Dashboard')

// Visibility
await expect(page.locator('.error')).toBeVisible()
await expect(page.locator('.spinner')).toBeHidden()

// URL
await expect(page).toHaveURL(/.*dashboard/)

// Count
await expect(page.locator('li.item')).toHaveCount(5)
```

### Screenshots
```typescript
// Full page
await page.screenshot({ path: 'screenshot.png', fullPage: true })

// Specific element
await page.locator('.chart').screenshot({ path: 'chart.png' })
```

### Waiting
```typescript
// Wait for navigation
await page.waitForURL('**/dashboard')

// Wait for element
await page.waitForSelector('.loaded')

// Wait for network
await page.waitForResponse(resp => resp.url().includes('/api/data'))
```

## Testing Strategy

1. **Start the dev server** before running browser tests
2. **Use data-testid attributes** for reliable element selection
3. **Wait for network idle** after navigation to ensure page is fully loaded
4. **Take screenshots** at key verification points for visual evidence
5. **Clean up**: always close the browser in a finally block

## Common Selectors Priority
1. `[data-testid="..."]` - most reliable
2. `role=button[name="..."]` - accessible
3. `text="..."` - readable but fragile
4. `.class-name` - depends on styling
5. CSS selectors - last resort

## Error Recovery
- If element not found, wait and retry with increased timeout
- If navigation fails, check if dev server is running
- Take a screenshot on failure for debugging
</skill-instruction>
