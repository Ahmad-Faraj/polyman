# Mutant (WA) in Python: reads the input as if it held one test case, so it
# answers only the first one and the other answers are missing.
input()
n = int(input())
a = input().split()
print(len(set(a)))
