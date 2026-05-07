# GitHub Setup Script
Write-Host "=== GitHub Setup ===" -ForegroundColor Cyan

Set-Location $PSScriptRoot

Write-Host "`n[1/4] Committing changes..." -ForegroundColor Yellow
git add .
git commit -m "feat: fix multi-person smile count, add v1.1 version tag"

Write-Host "`n[2/4] Enter your GitHub username:" -ForegroundColor Yellow
$username = Read-Host "GitHub username"

Write-Host "`n[3/4] Setting up remote..." -ForegroundColor Yellow
git remote add origin "https://github.com/$username/smile-detection-app.git"

Write-Host "`n[4/4] Pushing to GitHub..." -ForegroundColor Yellow
git push -u origin master

Write-Host "`nDone! Connect your repo to Vercel at:" -ForegroundColor Green
Write-Host "https://vercel.com/dashboard" -ForegroundColor Cyan
Read-Host "`nPress Enter to close"
