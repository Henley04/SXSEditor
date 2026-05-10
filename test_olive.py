import sys
import os

PYTHON = r"C:\Users\15240\AppData\Local\Python\bin\python3.exe"
SCRIPTS_DIR = r"C:\Users\15240\AppData\Local\Python\pythoncore-3.14-64\Scripts"
OLIVE = os.path.join(SCRIPTS_DIR, "olive.exe")

print(f"Olive path: {OLIVE}")
print(f"Exists: {os.path.exists(OLIVE)}")

# Try running olive
import subprocess
result = subprocess.run([OLIVE, "--help"], capture_output=True, text=True, timeout=30)
print("STDOUT:", result.stdout[:500])
print("STDERR:", result.stderr[:500] if result.stderr else "None")
print("Return code:", result.returncode)
