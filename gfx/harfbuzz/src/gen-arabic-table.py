#!/usr/bin/python

import sys

if len (sys.argv) < 2:
	print >>sys.stderr, "usage: ./gen-arabic-table.py ArabicShaping.txt"
	sys.exit (1)

f = file (sys.argv[1])

header = f.readline (), f.readline ()
while f.readline ().find ('##################') < 0:
	pass


print "/* == Start of generated table == */"
print "/*"
print " * The following table is generated by running:"
print " *"
print " *   ./gen-arabic-table.py ArabicShaping.txt"
print " *"
print " * on files with these headers:"
print " *"
for line in header:
	print " * %s" % (line.strip())
print " */"

print "static const uint8_t joining_table[] ="
print "{"


min_u = 0x110000
max_u = 0
num = 0
last = -1
block = ''
for line in f:

	if line[0] == '#':
		if line.find (" characters"):
			block = line[2:].strip ()
		continue

	fields = [x.strip () for x in line.split (';')]
	if len (fields) == 1:
		continue

	u = int (fields[0], 16)
	if u == 0x200C or u == 0x200D:
		continue
	if u < last:
		raise Exception ("Input data character not sorted", u)
	min_u = min (min_u, u)
	max_u = max (max_u, u)
	num += 1

	if block:
		print "\n  /* %s */\n" % block
		block = ''

	if last != -1:
		last += 1
		while last < u:
			print "  JOINING_TYPE_X, /* %04X */" % last
			last += 1
	else:
		last = u

	if fields[3] in ["ALAPH", "DALATH RISH"]:
		value = "JOINING_GROUP_" + fields[3].replace(' ', '_')
	else:
		value = "JOINING_TYPE_" + fields[2]
	print "  %s, /* %s */" % (value, '; '.join(fields))

print
print "};"
print

print "#define JOINING_TABLE_FIRST	0x%04X" % min_u
print "#define JOINING_TABLE_LAST	0x%04X" % max_u
print

print "/* == End of generated table == */"

occupancy = num * 100 / (max_u - min_u + 1)
# Maintain at least 40% occupancy in the table */
if occupancy < 40:
	raise Exception ("Table too sparse, please investigate: ", occupancy)
