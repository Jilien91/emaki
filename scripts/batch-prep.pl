use strict;
use warnings;
use utf8;
use JSON::PP;
binmode(STDOUT, ':encoding(UTF-8)');
binmode(STDERR, ':encoding(UTF-8)');

# Everything that has to be derived before writing a batch of mnemonics, in one
# command, run from the project root:
#
#   perl scripts/batch-prep.pl            the next 50 words, the kanji they
#                                         need, and every collision they create
#   perl scripts/batch-prep.pl 25         a different batch size
#   perl scripts/batch-prep.pl --kanji    stage two: the kanji reference to
#                                         write the mnemonics against
#
# Two stages because the deck is written in two passes. Fill in every missing
# data/kanji.json entry first and finish them, then run --kanji and write the
# mnemonics. See "Write the kanji entries first" in the style guide.
#
# The reason this file exists rather than a handful of one-liners per batch:
#   - The next free batch number is computed numerically. Reading it off a
#     directory listing sorts "batch10" before "batch2", which is how an
#     existing batch file once got overwritten.
#   - --kanji withholds the notes of entries written in the current pass. They
#     are the ones a mnemonic is most likely to quote back, having been written
#     an hour earlier, and 変化 shipped a twelve token lift of the 化 note
#     before this existed. What is not on screen cannot be echoed.
#   - Soft collisions are found by machine. verify.pl covers the exact ones
#     because they are correctness, but the notes worth writing tend to come
#     from near misses, and those were being spotted by eye.

my $json = JSON::PP->new->utf8(0);
sub slurp {
  my $p = shift;
  open(my $f, '<:encoding(UTF-8)', $p)
    or die "can't read $p: $!\nRun from the project root: perl scripts/batch-prep.pl\n";
  local $/;
  return $json->decode(<$f>);
}

# The upstream deck is an Anki export, so 183 of the text fields carry literal
# &nbsp;. merge.pl strips them at build time; do the same here so what is
# printed matches what ends up on the card.
sub clean {
  my $s = shift // '';
  $s =~ s/&nbsp;/ /g;
  $s =~ s/\x{00A0}/ /g;
  $s =~ s/\s+/ /g;
  $s =~ s/^\s+|\s+$//g;
  return $s;
}

my @args  = @ARGV;
my $kanji_mode = grep { $_ eq '--kanji' } @args;
my ($count)    = grep { /^\d+$/ } @args;
$count ||= 50;

my $full  = slurp('raw/kaishi_1500_full.json');
my $vocab = slurp('data/vocab.json');
my $kanji = slurp('data/kanji.json');

# ---- where the deck is up to ----------------------------------------------
my @written = grep { ($_->{mnemonic} // '') ne '' } @$vocab;
my %done    = map { $_->{id} => 1 } @written;
my $last    = 0;
$last++ while $done{$last + 1};
my @gaps    = grep { !$done{$_} } 1 .. ($written[-1]{id} || 0);

my $LO = $last + 1;
my $HI = $LO + $count - 1;
$HI = scalar(@$full) if $HI > scalar(@$full);

sub section { print "\n", '=' x 70, "\n", $_[0], "\n", '=' x 70, "\n" }

# ---- stage two: the kanji reference ---------------------------------------
if ($kanji_mode) {
  # Anything in kanji.json now that was not in it at HEAD was written in this
  # pass. No bookkeeping to keep in step, and it survives an interrupted
  # session: whatever is uncommitted is what is fresh.
  my %fresh;
  my $head = `git show HEAD:data/kanji.json 2>/dev/null`;
  if ($head) {
    utf8::decode($head);
    my $old = eval { $json->decode($head) };
    if ($old) {
      %fresh = map { $_ => 1 } grep { !exists $old->{$_} } keys %$kanji;
    } else {
      warn "warning: couldn't parse HEAD's kanji.json, showing every note\n";
    }
  } else {
    warn "warning: no HEAD version of kanji.json, showing every note\n";
  }

  section("KANJI REFERENCE for $LO-$HI"
    . "\nNotes are shown for entries that already existed. For the "
    . scalar(keys %fresh) . " written in this pass\nthe note is withheld on purpose: you wrote it, and a mnemonic that quotes it\nback says twice what the card already prints above it. Components are shown\nfor everything, because you need those to build a scene.");

  my (%seen, $withheld);
  for my $i ($LO - 1 .. $HI - 1) {
    for my $c (split //, $full->[$i]{word}) {
      next unless $c =~ /\p{Han}/;
      next if $seen{$c}++;
      my $e = $kanji->{$c};
      unless ($e) { printf "%s  *** MISSING from kanji.json ***\n", $c; next }
      printf "%s [%s]", $c, $e->{meaning};
      if ($e->{parts}) {
        printf "  %s\n", join ' + ', map { "$_->{c} $_->{name}" } @{ $e->{parts} };
      } elsif ($fresh{$c}) {
        print "  (note written this pass, withheld)\n";
        $withheld++;
      } else {
        printf "\n     %s\n", $e->{note};
      }
    }
  }
  $withheld ||= 0;
  printf "\n%d characters, %d note%s withheld.\n",
    scalar(keys %seen), $withheld, $withheld == 1 ? '' : 's';
  exit 0;
}

# ---- stage one -------------------------------------------------------------
section('STATE');
printf "written        %d of %d\n", scalar(@written), scalar(@$vocab);
printf "contiguous     %s\n", @gaps ? "NO, gaps at @gaps" : "yes, 1..$last";
printf "next batch     %d-%d (%d words)\n", $LO, $HI, $HI - $LO + 1;

my @nums = sort { $a <=> $b }
           map { /batch(\d+)_with_mnemonics\.json$/ ? $1 : () } glob('raw/*_with_mnemonics.json');
my $next = ($nums[-1] // 0) + 1;
my $target = "raw/kaishi_batch${next}_with_mnemonics.json";
printf "batch files    %d present, highest is %d\n", scalar(@nums), $nums[-1] // 0;
printf "write to       %s\n", $target;
die "\nFATAL: $target already exists. Numbering is wrong, stop and check.\n" if -e $target;

my $dirty = `git status --porcelain 2>/dev/null`;
if ($dirty) {
  utf8::decode($dirty);
  print "\nuncommitted changes present:\n";
  print "  $_\n" for grep { length } split /\r?\n/, $dirty;
  print "  (expected mid-batch, after the kanji pass. Otherwise finish that first.)\n";
}

section("WORDS $LO-$HI");
for my $i ($LO - 1 .. $HI - 1) {
  my $w = $full->[$i];
  printf "%d\t%s\t%s\t%s\n\t\t%s / %s\n",
    $i + 1, $w->{word}, $w->{reading}, clean($w->{meaning}),
    $w->{sentence}, clean($w->{sentence_meaning});
}

section('KANJI NEEDED');
my (%missing, %covered);
for my $i ($LO - 1 .. $HI - 1) {
  for my $c (split //, $full->[$i]{word}) {
    next unless $c =~ /\p{Han}/;
    exists $kanji->{$c} ? $covered{$c}++ : push @{ $missing{$c} }, $full->[$i]{word};
  }
}
printf "already covered (%d): %s\n\n", scalar(keys %covered), join ' ', sort keys %covered;
if (%missing) {
  printf "TO WRITE FIRST (%d):\n", scalar(keys %missing);
  printf "  %s   in: %s\n", $_, join(' ', @{ $missing{$_} }) for sort keys %missing;
} else {
  print "none missing, go straight to the mnemonics.\n";
}

# ---- collisions ------------------------------------------------------------
sub senses {
  my $s = lc clean(shift);
  $s =~ s/\([^)]*\)/ /g;
  return grep { length } map { s/^\s+|\s+$//gr } split m{[,/]}, $s;
}
sub label { my $i = shift; return $i + 1 <= $last ? '[written]' : '[THIS BATCH]' }

my @pool = @{$full}[0 .. $HI - 1];

# How many words each character appears in, used to keep the shared-character
# check to characters that are actually distinctive.
my $SHARE_MAX = 4;
my %charfreq;
for my $w (@pool) {
  my %once = map { $_ => 1 } grep { /\p{Han}/ } split //, $w->{word};
  $charfreq{$_}++ for keys %once;
}

section('COLLISIONS');
print "HARD, verify.pl enforces these. Each needs a note.\n\n";

my $hard = 0;
for my $i ($LO - 1 .. $HI - 1) {
  my $n = $full->[$i];
  my %seen;
  my @h = grep { $_->{reading} eq $n->{reading} && $_->{word} ne $n->{word} } @pool;
  if (@h) {
    $hard++;
    printf "  homophone  %s (%s) = %s\n", $n->{word}, $n->{reading}, clean($n->{meaning});
    for my $x (@h) {
      next if $seen{ $x->{word} }++;
      my $j = 0; $j++ while $pool[$j] != $x;
      printf "             vs #%d %s = %s %s\n", $j + 1, $x->{word}, clean($x->{meaning}), label($j);
    }
  }
  my @t = grep { $_->{word} eq $n->{word} && $_->{reading} ne $n->{reading} } @pool;
  if (@t) {
    $hard++;
    printf "  same word  %s: %s = %s\n", $n->{word}, $n->{reading}, clean($n->{meaning});
    for my $x (@t) {
      my $j = 0; $j++ while $pool[$j] != $x;
      printf "             vs #%d %s = %s %s\n", $j + 1, $x->{reading}, clean($x->{meaning}), label($j);
    }
    print "             twins must not share an example sentence, and each note must name the other.\n";
  }
}
print "  none.\n" unless $hard;

print "\nSOFT, nothing enforces these. This is where the useful notes come from.\n\n";
my $soft = 0;
for my $i ($LO - 1 .. $HI - 1) {
  my $n = $full->[$i];
  my @hits;

  # The same character carrying its weight in a different word. Only worth
  # raising for characters the deck uses sparingly: 人 and 手 turn up in a
  # dozen words each and pairing them off says nothing, whereas 息 in exactly
  # 息 and 息子, or 駄 in 駄目 and 無駄, is a note that writes itself.
  my %chars = map { $_ => 1 } grep { /\p{Han}/ && $charfreq{$_} <= $SHARE_MAX }
              split //, $n->{word};
  for my $j (0 .. $#pool) {
    next if $j == $i;
    my $x = $pool[$j];
    next if $x->{word} eq $n->{word};
    my @shared = grep { index($x->{word}, $_) >= 0 } keys %chars;
    push @hits, sprintf("shares %s with #%d %s (%s) = %s %s",
      join('', sort @shared), $j + 1, $x->{word}, $x->{reading}, clean($x->{meaning}), label($j))
      if @shared;
  }

  # Readings near enough to be confused for one another. Two shapes catch it:
  # the same length differing in a single mora, which is 息子 むすこ against
  # 娘 むすめ, and a long shared opening, which is the どう family. A plain
  # two-mora prefix matches half the deck and is not worth printing.
  if (length $n->{reading} >= 3) {
    for my $j (0 .. $#pool) {
      next if $j == $i;
      my $x = $pool[$j];
      next if $x->{word} eq $n->{word} || length $x->{reading} < 3;
      next if $x->{reading} eq $n->{reading};   # already a hard homophone
      my $p = 0;
      $p++ while $p < length($n->{reading}) && $p < length($x->{reading})
             && substr($n->{reading}, $p, 1) eq substr($x->{reading}, $p, 1);
      my $one_off = length($n->{reading}) == length($x->{reading})
                 && (grep { substr($n->{reading}, $_, 1) ne substr($x->{reading}, $_, 1) }
                     0 .. length($n->{reading}) - 1) == 1;
      push @hits, sprintf("sounds like #%d %s (%s) = %s %s",
        $j + 1, $x->{word}, $x->{reading}, clean($x->{meaning}), label($j))
        if $one_off || $p >= 3;
    }
  }

  # and words the learner could answer with instead
  my %mine = map { $_ => 1 } senses($n->{meaning});
  for my $j (0 .. $#pool) {
    next if $j == $i;
    my $x = $pool[$j];
    next if $x->{word} eq $n->{word};
    my @s = grep { $mine{$_} } senses($x->{meaning});
    push @hits, sprintf("same sense \"%s\" as #%d %s (%s) %s",
      $s[0], $j + 1, $x->{word}, $x->{reading}, label($j)) if @s;
  }

  next unless @hits;
  $soft++;
  printf "  #%d %s (%s) = %s\n", $i + 1, $n->{word}, $n->{reading}, clean($n->{meaning});
  printf "       %s\n", $_ for @hits[0 .. ($#hits > 5 ? 5 : $#hits)];
  printf "       ...and %d more\n", @hits - 6 if @hits > 6;
}
print "  none.\n" unless $soft;

section('NEXT');
print <<"END";
1. Write every missing data/kanji.json entry above. Finish them.
2. perl scripts/batch-prep.pl --kanji
3. Write the mnemonics against that, into $target
4. perl scripts/merge.pl
5. perl /c/Dev/emaki-private/verify.pl $LO $HI
END
