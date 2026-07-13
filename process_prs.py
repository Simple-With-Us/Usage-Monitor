import subprocess
import sys

prs = [98, 99, 100, 101]

def run(cmd):
    print(f"Running: {cmd}")
    res = subprocess.run(cmd, shell=True)
    if res.returncode != 0:
        print(f"Failed at: {cmd}")
        sys.exit(1)

for pr in prs:
    print(f"--- Processing PR {pr} ---")
    run("git fetch origin")
    run(f"gh pr checkout {pr}")
    
    res = subprocess.run("git merge origin/main --no-edit", shell=True)
    if res.returncode != 0:
        print(f"Conflict merging origin/main into PR {pr}. Attempting npm install to fix package.json/lock conflicts.")
        res_npm = subprocess.run("npm install", shell=True)
        if res_npm.returncode != 0:
             print("npm install failed. Aborting.")
             sys.exit(1)
        res_add = subprocess.run("git add package.json package-lock.json && git commit -m 'resolve conflict'", shell=True)
        if res_add.returncode != 0:
             print("Still have conflicts after npm install. Aborting.")
             sys.exit(1)
             
    # check if package-lock.json was modified
    res_diff = subprocess.run("git diff --quiet package-lock.json", shell=True)
    if res_diff.returncode != 0:
        run("git add package-lock.json && git commit -m 'update package-lock.json'")

    run("git push")
    run(f"gh pr merge {pr} --admin --squash")
