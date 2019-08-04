package advCode;

import java.util.Scanner;

public class Ex23 {

	public static void main(String[] args) {
		// TODO Auto-generated method stub

		
//		System.out.printf("%-15s %15s", "Exam Name", "Exam Grade");
//		System.out.println("\n-----------------------------------");
//		System.out.printf("%-15s %10s", "Java", "A");
//		System.out.printf("%n%-15s %10s", "PHP", "B");
//		System.out.printf("%n%-15s %10s", "VB NET", "A");
//		System.out.println("\n-----------------------------------");
		
//		Scanner scan = new Scanner(System.in);
//		System.out.println("Enter the first number: ");
//		int a = scan.nextInt();		
//		System.out.println("Enter the second number: ");
//		int b = scan.nextInt();
//		double sum = (double) a / b;
//		System.out.printf("Sum = %.3f" , sum);
//		scan.close();
		
//		int g = Integer.MAX_VALUE;
//		int h = Integer.MAX_VALUE;
//		long result = (long) g+h;
//		System.out.println(result);	
//
//		Scanner userInput = new Scanner(System.in);
//        System.out.print("Insert float: \n");
//        try {
//            float firstNumer = userInput.nextFloat();
//    } catch (Exception e) {
//            System.out.print("vezi ca nu ai introdus corect float: \n");
//        }
//        
//        System.out.print("Insert byte: \n");
//        try {
//            byte secondNumber = userInput.nextByte();
//    } catch (Exception e) {
//            System.out.print("vezi ca nu ai introdus corect float");
//        }
//        
//        System.out.printf("Insert char: \n");
//    char secondNumber = userInput.next().charAt(0);
//        
//         userInput.close();      
		
//		Scanner in = new Scanner(System.in);
//		System.out.println("Input an int number: ");
//		int s = 0;
//		try {
//			 s = in.nextInt();
//			 if (s < 30) {
//					System.out.println("Your input is < 30 !");
//				} else if(s > 30){
//					System.out.println("Your input is > 30 !");
//				}else System.out.println("Your input equals 30 !");
//		} catch (Exception e) {
//			System.out.println("Your input is wrong !!");
//		}
//		in.close();
		
        System.out.println("Insert the first number: ");

        int input1 = getUserInput();

        System.out.println("Insert the second number: ");

        int input2 = getUserInput();

        System.out.println(compareBothNumbers(input1, input2));

    }

//************************************************************************************************************

    private static int getUserInput() {

        int number = 0;

        Scanner scanner = new Scanner(System.in);

        try {

            number = scanner.nextInt();

        } catch (Exception e) {

            System.out.println("You entered a wrong type !");

        }

        // scanner.close();

        return number;

    }

//************************************************************************************************************

//    private static String compareTwoNumbersWithTirthy(int number1, int number2) {
//
//        final int THIRTY = 30;
//
//        String compareResult = "";
//
//        if ((number1 < THIRTY) && (number2 < THIRTY)) {
//
//            compareResult = String.format("The inserted numbers %s and %s is smaller than 30 %n", number1, number2);
//
//        } else if ((number1 > THIRTY) && (number2 > THIRTY)) {
//
//            compareResult = String.format("The inserted numbers %s and %s is grater than 30 %n", number1, number2);
//
//        } else if (((number1 == THIRTY) && (number2 == THIRTY))) {
//
//            compareResult = String.format("The inserted numbers %s and %s is equal to 30 %n", number1, number2);
//
//        } else {
//
//            compareResult = String.format("None of expected conditions are met with regards to compare");
//
//        }

//        return compareResult;

    
    	private static String compareBothNumbers(int number, int number2) {
    		final int THIRTY = 30;
    		String compareBNum = "";
    		if ((number == THIRTY) && (number2 == THIRTY)) {
    			compareBNum = "Both numbers are equal to THIRTY !";
    		}else if ((number > THIRTY) && (number2 > THIRTY)) {
    			compareBNum = "Both numbers are > then THIRTY !";
    		}else if ((number < THIRTY) && (number2 < THIRTY)) {
    			compareBNum = "Both numbers are < then THIRTY !";
    		}else System.out.println("None of expected conditions are met !");
    		return compareBNum;
    	}
    



//******************************************************************************************************
    }

