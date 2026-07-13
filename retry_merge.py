import subprocess
import time

while True:
    res = subprocess.run("gh pr merge 101 --admin --squash", shell=True)
    if res.returncode == 0:
        break
    print("Retrying in 2 seconds...")
    time.sleep(2)
